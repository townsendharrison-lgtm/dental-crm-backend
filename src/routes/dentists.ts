import { Router } from 'express';

export const dentistsRouter = Router();

// ─── Geocoding cache (in-memory, persists for server lifetime) ──────
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

async function geocodeAddress(street: string, city: string, state: string, zip: string): Promise<{ lat: number; lng: number } | null> {
  // Build a cache key from the address components
  const cacheKey = `${street}|${city}|${state}|${zip}`.toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)!;

  // Try progressively less specific queries for better hit rate
  const queries = [
    `${street}, ${city}, ${state} ${zip}`,
    `${city}, ${state} ${zip}`,
    `${zip}, ${state}`,
  ];

  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=us`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'DentalSchoolGuideCRM/1.0' },
      });
      if (!r.ok) continue;
      const data: any = await r.json();
      if (data && data.length > 0) {
        const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        geocodeCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      // Continue to next query
    }
  }

  geocodeCache.set(cacheKey, null);
  return null;
}

// Rate-limited batch geocoding — 1 request per second for Nominatim compliance
async function batchGeocode(rows: any[], maxCount: number = 50): Promise<void> {
  const toGeocode = rows.slice(0, maxCount).filter(r => r.address || r.city || r.zip);
  let successCount = 0;
  for (let i = 0; i < toGeocode.length; i++) {
    const r = toGeocode[i];
    const result = await geocodeAddress(r.address, r.city, r.state, r.zip);
    if (result) {
      r.latitude = result.lat;
      r.longitude = result.lng;
      successCount++;
    } else {
      console.warn(`Geocoding failed for: ${r.address}, ${r.city}, ${r.state} ${r.zip}`);
    }
    // Rate limit: wait 1.1s between requests (Nominatim requires max 1 req/s)
    if (i < toGeocode.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }
  console.log(`Geocoded ${successCount}/${toGeocode.length} addresses`);
}

dentistsRouter.get('/', async (req, res) => {
  try {
    const { zip, city, state, name } = req.query;

    const q1 = new URLSearchParams();
    q1.set("version", "2.1");
    q1.set("enumeration_type", "NPI-1");
    q1.set("taxonomy_description", "Dentist");

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
        shadowFriendliness: {
          allowedPercentage: Math.floor(Math.random() * 100),
          avgRating: (Math.random() * 2 + 3).toFixed(1),
          totalReports: Math.floor(Math.random() * 20)
        }
      };
    };

    merged = merged.filter(isDentistRecord).map(toRow);

    const m = new Map();
    merged.forEach(x => { if (!m.has(x.npi)) m.set(x.npi, x); });
    merged = Array.from(m.values());
    merged = merged.filter(r => !/\bhygienist\b/i.test(r.specialty || ""));

    // Geocode results for real map pins (rate-limited)
    // Geocode up to 50 results to ensure distance calculations work for more dentists
    await batchGeocode(merged, 50);

    res.json(merged);
  } catch (error) {
    console.error('Error in dentists route:', error);
    res.status(500).json({ error: 'Failed to fetch dentists' });
  }
});
