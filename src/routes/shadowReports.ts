import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase.js';

export const shadowReportsRouter = Router();

// ─── POST /api/shadow-reports ────────────────────────────────────────
// Submit a shadow report for a dentist (public, rate-limited by IP+NPI)
shadowReportsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { npi, allowed, rating } = req.body;

    // Validate required fields
    if (!npi || typeof allowed !== 'boolean' || !rating) {
      return res.status(400).json({ error: 'Missing required fields: npi, allowed, rating' });
    }

    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
    }

    // Hash IP for privacy-preserving rate limiting
    const rawIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ipString = Array.isArray(rawIp) ? rawIp[0] : String(rawIp);
    const ipHash = crypto.createHash('sha256').update(ipString).digest('hex').slice(0, 16);

    // Rate limit: 1 report per NPI per IP per 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabaseAdmin
      .from('dentist_shadow_reports')
      .select('id')
      .eq('npi', String(npi))
      .eq('ip_hash', ipHash)
      .gte('created_at', twentyFourHoursAgo)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(429).json({
        error: 'You have already submitted a report for this dentist in the last 24 hours.',
      });
    }

    // Insert the report
    const { error } = await supabaseAdmin.from('dentist_shadow_reports').insert({
      npi: String(npi),
      allowed,
      rating: ratingNum,
      ip_hash: ipHash,
    });

    if (error) {
      console.error('Shadow report insert error:', error);
      return res.status(500).json({ error: 'Failed to save report' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Shadow report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/shadow-reports/stats?npis=NPI1,NPI2,... ───────────────
// Batch-fetch aggregated shadow stats for a list of NPIs
shadowReportsRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const npisParam = req.query.npis as string;
    if (!npisParam) {
      return res.json({});
    }

    const npiList = npisParam.split(',').map(n => n.trim()).filter(Boolean);
    if (npiList.length === 0) {
      return res.json({});
    }

    // Fetch all reports for these NPIs
    const { data: reports, error } = await supabaseAdmin
      .from('dentist_shadow_reports')
      .select('npi, allowed, rating')
      .in('npi', npiList);

    if (error) {
      console.error('Shadow stats fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }

    // Aggregate in memory
    const statsMap: Record<string, { allowedPercentage: number; avgRating: number; totalReports: number }> = {};

    // Group reports by NPI
    const grouped: Record<string, Array<{ allowed: boolean; rating: number }>> = {};
    for (const r of (reports || [])) {
      if (!grouped[r.npi]) grouped[r.npi] = [];
      grouped[r.npi].push({ allowed: r.allowed, rating: r.rating });
    }

    for (const npi of Object.keys(grouped)) {
      const recs = grouped[npi];
      const total = recs.length;
      const allowedCount = recs.filter(r => r.allowed).length;
      const ratingSum = recs.reduce((sum, r) => sum + r.rating, 0);

      statsMap[npi] = {
        allowedPercentage: total > 0 ? Math.round((allowedCount / total) * 100) : 0,
        avgRating: total > 0 ? Number((ratingSum / total).toFixed(1)) : 0,
        totalReports: total,
      };
    }

    res.json(statsMap);
  } catch (err) {
    console.error('Shadow stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
