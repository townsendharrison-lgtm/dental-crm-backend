import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';

export const dentistsRouter = Router();

// Haversine Formula for distance calculation (miles)
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ─── Geocoding cache (in-memory, persists for server lifetime) ──────
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

// Rate-limiting OSM Nominatim calls (compliance with 1 request per second policy)
let lastGeocodeTime = 0;
async function rateLimitNominatim(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastGeocodeTime;
  if (timeSinceLast < 1100) {
    await new Promise(resolve => setTimeout(resolve, 1100 - timeSinceLast));
  }
  lastGeocodeTime = Date.now();
}

async function getCachedGeocodes(addressKeys: string[]): Promise<Map<string, { lat: number; lng: number } | null>> {
  const result = new Map<string, { lat: number; lng: number } | null>();
  if (addressKeys.length === 0) return result;

  try {
    const { data, error } = await supabaseAdmin
      .from('dentist_geocodes')
      .select('address_key, latitude, longitude')
      .in('address_key', addressKeys);

    if (error) {
      console.error('Error fetching cached geocodes:', error);
      return result;
    }

    for (const row of (data || [])) {
      if (row.latitude !== null && row.longitude !== null) {
        result.set(row.address_key, { lat: row.latitude, lng: row.longitude });
      } else {
        result.set(row.address_key, null);
      }
    }
  } catch (err) {
    console.error('Error in getCachedGeocodes:', err);
  }

  return result;
}

async function saveCachedGeocode(addressKey: string, lat: number | null, lng: number | null): Promise<void> {
  try {
    await supabaseAdmin
      .from('dentist_geocodes')
      .upsert({
        address_key: addressKey,
        latitude: lat,
        longitude: lng
      }, { onConflict: 'address_key' });
  } catch (err) {
    console.error('Error saving cached geocode:', err);
  }
}

async function geocodeAddress(street: string, city: string, state: string, zip: string): Promise<{ lat: number; lng: number } | null> {
  const cacheKey = `${street}|${city}|${state}|${zip}`.toLowerCase().trim();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)!;

  // Check database cache first
  try {
    const { data, error } = await supabaseAdmin
      .from('dentist_geocodes')
      .select('latitude, longitude')
      .eq('address_key', cacheKey)
      .limit(1);

    if (!error && data && data.length > 0) {
      const row = data[0];
      const result = row.latitude !== null && row.longitude !== null 
        ? { lat: row.latitude, lng: row.longitude } 
        : null;
      geocodeCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {
    console.error('Database cache fetch error:', err);
  }

  // Fallback to query Nominatim
  const queries: string[] = [];
  if (street || city || state || zip) {
    queries.push([street, city, state, zip].filter(Boolean).join(', '));
    queries.push([city, state, zip].filter(Boolean).join(', '));
    queries.push([zip, state].filter(Boolean).join(', '));
  }

  let searchAttemptedSuccessfully = false;

  for (const q of queries) {
    try {
      await rateLimitNominatim();
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=us`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'DentalSchoolGuideCRM/1.0' },
      });
      
      if (!r.ok) {
        console.warn(`Nominatim returned status ${r.status} for query: ${q}`);
        continue;
      }
      
      const data: any = await r.json();
      searchAttemptedSuccessfully = true;

      if (data && data.length > 0) {
        const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        geocodeCache.set(cacheKey, result);
        await saveCachedGeocode(cacheKey, result.lat, result.lng);
        return result;
      }
    } catch (err) {
      console.error(`Nominatim query error for "${q}":`, err);
    }
  }

  // Only cache failure if we successfully communicated with Nominatim and it found no results
  if (searchAttemptedSuccessfully) {
    geocodeCache.set(cacheKey, null);
    await saveCachedGeocode(cacheKey, null, null);
  }
  return null;
}

async function getShadowStatsForNpis(npiList: string[]): Promise<Record<string, { allowedPercentage: number; avgRating: number; totalReports: number }>> {
  const statsMap: Record<string, { allowedPercentage: number; avgRating: number; totalReports: number }> = {};
  if (npiList.length === 0) return statsMap;

  try {
    const { data: reports, error } = await supabaseAdmin
      .from('dentist_shadow_reports')
      .select('npi, allowed, rating')
      .in('npi', npiList);

    if (error) {
      console.error('Shadow stats batch fetch error:', error);
      return statsMap;
    }

    const grouped: Record<string, Array<{ allowed: boolean; rating: number }>> = {};
    for (const r of (reports || [])) {
      if (!grouped[r.npi]) grouped[r.npi] = [];
      grouped[r.npi].push({ allowed: r.allowed, rating: r.rating });
    }

    for (const npi of npiList) {
      const recs = grouped[npi] || [];
      const total = recs.length;
      const allowedCount = recs.filter(r => r.allowed).length;
      const ratingSum = recs.reduce((sum, r) => sum + r.rating, 0);

      statsMap[npi] = {
        allowedPercentage: total > 0 ? Math.round((allowedCount / total) * 100) : 0,
        avgRating: total > 0 ? Number((ratingSum / total).toFixed(1)) : 0,
        totalReports: total,
      };
    }
  } catch (err) {
    console.error('Error in getShadowStatsForNpis:', err);
  }

  return statsMap;
}

dentistsRouter.get('/', async (req, res) => {
  try {
    const { zip, city, state, name, specialty, sortBy } = req.query;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const maxDistance = parseFloat(req.query.maxDistance as string) || 25;
    const userLat = req.query.userLat ? parseFloat(req.query.userLat as string) : null;
    const userLng = req.query.userLng ? parseFloat(req.query.userLng as string) : null;

    const q1 = new URLSearchParams();
    q1.set("version", "2.1");
    q1.set("enumeration_type", "NPI-1");
    
    if (specialty) {
      q1.set("taxonomy_code", specialty as string);
    } else {
      q1.set("taxonomy_description", "Dentist");
    }

    if (zip) q1.set("postal_code", `${zip}*`);
    if (state) q1.set("state", state as string);
    if (city) q1.set("city", city as string);
    if (name) {
      const tokens = (name as string).trim().split(/\s+/);
      if (tokens.length >= 2) { 
        q1.set("first_name", tokens[0]); 
        q1.set("last_name", tokens.slice(1).join(" ")); 
      } else { 
        q1.set("last_name", (name as string).trim()); 
      }
    }

    const q2 = new URLSearchParams(q1.toString());
    q2.set("enumeration_type", "NPI-2");
    if (name) {
      q2.delete("first_name");
      q2.delete("last_name");
      q2.set("organization_name", (name as string).trim());
    }

    q1.set("limit", "200");
    q2.set("limit", "200");

    const fetchDentists = async (q: URLSearchParams) => {
      const url = "https://npiregistry.cms.hhs.gov/api/?" + q.toString();
      try {
        const r = await fetch(url);
        if (!r.ok) return [];
        const data: any = await r.json();
        return data.results || [];
      } catch (err) {
        console.error("NPI fetch error:", err);
        return [];
      }
    };

    const [res1, res2] = await Promise.all([
      fetchDentists(q1),
      fetchDentists(q2)
    ]);

    let merged = [...res1, ...res2];

    const isDentistTaxonomy = (t: any) => {
      const code = (t.code || "").toUpperCase();
      const desc = (t.desc || t.description || "").toLowerCase();
      if (code.startsWith("124Q") || desc.includes("hygienist")) return false;
      return code.startsWith("1223") || /\bdentist\b/i.test(desc);
    };

    const isDentistRecord = (r: any) => {
      const tax = r.taxonomies || [];
      return tax.some(isDentistTaxonomy);
    };

    const toRow = (r: any) => {
      const basic = r.basic || {};
      const isOrg = !!(basic.organization_name || r.enumeration_type === "NPI-2");
      const practiceName = isOrg
        ? (basic.organization_name || basic.name || "Unknown Practice")
        : [basic.first_name, basic.last_name].filter(Boolean).join(" ").trim() || "Unknown";

      const addr = (r.addresses || []).find((a: any) => a.address_purpose === "LOCATION") || (r.addresses || [])[0] || {};
      const phone = addr.telephone_number || "";
      const street = [addr.address_1, addr.address_2].filter(Boolean).join(", ");
      const cityStr = addr.city || "";
      const stateStr = addr.state || "";
      const zipCode = (addr.postal_code || "").slice(0, 5);

      const dentistTax = (r.taxonomies || []).find(isDentistTaxonomy);
      const spec = dentistTax ? (dentistTax.desc || dentistTax.description) : (isOrg ? "Dental Practice" : "Dentist");

      return { 
        npi: r.number,
        name: practiceName, 
        specialty: spec, 
        phone, 
        address: street, 
        city: cityStr, 
        state: stateStr, 
        zip: zipCode, 
        latitude: null as number | null,
        longitude: null as number | null,
        distance: undefined as number | undefined,
        shadowStats: undefined as any
      };
    };

    // Filter and map NPPES results
    merged = merged.filter(isDentistRecord).map(toRow);

    // De-duplicate by NPI
    const m = new Map();
    merged.forEach(x => { if (!m.has(x.npi)) m.set(x.npi, x); });
    merged = Array.from(m.values());
    merged = merged.filter(r => !/\bhygienist\b/i.test(r.specialty || ""));

    // 1. Batch fetch cached coordinates from Supabase to avoid individual database queries
    const addressKeys = merged.map(r => `${r.address}|${r.city}|${r.state}|${r.zip}`.toLowerCase().trim());
    const dbCache = await getCachedGeocodes(addressKeys);

    // Apply cached coordinates to dentists list
    merged.forEach(r => {
      const key = `${r.address}|${r.city}|${r.state}|${r.zip}`.toLowerCase().trim();
      if (dbCache.has(key)) {
        const coords = dbCache.get(key);
        if (coords) {
          r.latitude = coords.lat;
          r.longitude = coords.lng;
        }
      }
    });

    // 2. Batch fetch shadow stats from Supabase
    const npiList = merged.map(r => r.npi);
    const statsMap = await getShadowStatsForNpis(npiList);
    merged.forEach(r => {
      r.shadowStats = statsMap[r.npi] || { allowedPercentage: 0, avgRating: 0, totalReports: 0 };
    });

    // 3. Determine the coordinate origin for distance calculation (Miles)
    let originLat: number | null = userLat;
    let originLng: number | null = userLng;

    if (originLat === null || originLng === null) {
      const parts: string[] = [];
      if (city) parts.push(city as string);
      if (state) parts.push(state as string);
      if (zip) parts.push(zip as string);

      if (parts.length > 0) {
        const searchAddr = parts.join(', ');
        const searchOrigin = await geocodeAddress('', '', '', searchAddr);
        if (searchOrigin) {
          originLat = searchOrigin.lat;
          originLng = searchOrigin.lng;
        }
      }
    }

    // 4. Calculate distances from origin if coordinates are available
    if (originLat !== null && originLng !== null) {
      merged.forEach(r => {
        if (r.latitude !== null && r.longitude !== null) {
          r.distance = calculateDistance(originLat!, originLng!, r.latitude, r.longitude);
        }
      });
    }

    // 5. Sort results (distance is used for sorting, NOT for hard-filtering,
    //    so pagination is consistent regardless of geocode cache state).
    merged.sort((a, b) => {
      const distA = a.distance ?? 9999;
      const distB = b.distance ?? 9999;

      switch (sortBy) {
        case 'nearest':
          return distA - distB;
        case 'rating':
          return (b.shadowStats?.avgRating || 0) - (a.shadowStats?.avgRating || 0);
        case 'friendly':
          return (b.shadowStats?.allowedPercentage || 0) - (a.shadowStats?.allowedPercentage || 0);
        case 'alpha':
        default:
          return a.name.localeCompare(b.name);
      }
    });

    // 6. Paginate the sorted results
    const totalResults = merged.length;
    const totalPages = Math.ceil(totalResults / limit);
    const startIdx = (page - 1) * limit;
    const pageSlice = merged.slice(startIdx, startIdx + limit);

    // 7. Synchronously geocode ONLY the pageSlice items that are uncached
    // (This guarantees the current page's map pins will render correctly)
    for (const dentist of pageSlice) {
      if (dentist.latitude === null || dentist.longitude === null) {
        const coords = await geocodeAddress(dentist.address, dentist.city, dentist.state, dentist.zip);
        if (coords) {
          dentist.latitude = coords.lat;
          dentist.longitude = coords.lng;
          if (originLat !== null && originLng !== null) {
            dentist.distance = calculateDistance(originLat, originLng, coords.lat, coords.lng);
          }
        }
      }
    }

    res.json({
      results: pageSlice,
      total: totalResults,
      page,
      totalPages
    });
  } catch (error) {
    console.error('Error in dentists route:', error);
    res.status(500).json({ error: 'Failed to fetch dentists' });
  }
});
