/**
 * Authenticated proxy: browser → Node → school-ai-service.
 * Never expose SCHOOL_AI_INTERNAL_KEY to the frontend.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import {
  createSchoolAiClient,
  SchoolAiClientError,
} from '../services/schoolAiClient.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});
const ai = createSchoolAiClient();

router.use(authenticate);

function mapAiError(error: unknown, res: Response) {
  if (error instanceof SchoolAiClientError) {
    return res.status(error.status || 502).json({ error: error.message, detail: error.body });
  }
  const message = error instanceof Error ? error.message : 'School AI request failed';
  return res.status(502).json({ error: message });
}

function profileToAttributes(profile: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const gpa = profile.gpa ?? profile.cgpa;
  const sgpa = profile.sgpa;
  const datAa = profile.dat_aa ?? profile.datAa;
  const datTs = profile.dat_ts ?? profile.datTs;
  const datPat = profile.dat_pat ?? profile.datPat;
  const datBio = profile.dat_bio ?? profile.datBio;
  const datGc = profile.dat_gc ?? profile.datGc;
  const datOc = profile.dat_oc ?? profile.datOc;
  const datRc = profile.dat_rc ?? profile.datRc;
  const datQr = profile.dat_qr ?? profile.datQr;
  const shadowing = profile.shadowing_hours ?? profile.shadowingHours;
  const datScale = profile.dat_score_scale ?? profile.datScoreScale;
  if (gpa != null && gpa !== '') attrs.avg_gpa = Number(gpa);
  if (sgpa != null && sgpa !== '') attrs.avg_science_gpa = Number(sgpa);
  // Taxonomy keys are avg_dat_*; CRM stores section columns without the avg_ prefix.
  if (datAa != null && datAa !== '') attrs.avg_dat_aa = Number(datAa);
  if (datTs != null && datTs !== '') attrs.avg_dat_total_science = Number(datTs);
  if (datPat != null && datPat !== '') attrs.avg_dat_pat = Number(datPat);
  if (datBio != null && datBio !== '') attrs.avg_dat_biology = Number(datBio);
  if (datGc != null && datGc !== '') attrs.avg_dat_general_chemistry = Number(datGc);
  if (datOc != null && datOc !== '') attrs.avg_dat_organic_chemistry = Number(datOc);
  if (datRc != null && datRc !== '') attrs.avg_dat_reading_comprehension = Number(datRc);
  if (datQr != null && datQr !== '') attrs.avg_dat_quantitative_reasoning = Number(datQr);
  if (shadowing != null && shadowing !== '') attrs.shadowing_hours = Number(shadowing);
  // Hint for dual-scale DAT scoring (legacy 1–30 vs modern 200–600).
  if (datScale != null && String(datScale).trim() !== '') {
    attrs.dat_score_scale = String(datScale).trim();
  }
  return attrs;
}

function kpiFromScore(score: number): 'Strong' | 'Moderate' | 'Developing' | 'Weak' {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Developing';
  return 'Weak';
}

async function ensureLinkedAiSchool(
  crmSchool: { id: string; name: string; ai_school_id?: string | null; notes?: string | null },
  officialUrl?: string,
) {
  if (crmSchool.ai_school_id) {
    return { aiSchoolId: crmSchool.ai_school_id, created: false };
  }
  const url =
    (officialUrl && String(officialUrl).trim()) ||
    `https://admissions.placeholder.invalid/${encodeURIComponent(crmSchool.name.trim().toLowerCase().replace(/\s+/g, '-'))}`;
  const created = await ai.createSchool(crmSchool.name, url);
  const { error } = await supabaseAdmin
    .from('schools')
    .update({ ai_school_id: created.school_id, updated_at: new Date().toISOString() })
    .eq('id', crmSchool.id);
  if (error) {
    // Column may be missing before migration 059 — still return the AI id for this request.
    console.warn('Could not persist ai_school_id (apply migration 059):', error.message);
  }
  return { aiSchoolId: created.school_id, created: true };
}

type CrmSchoolRow = {
  id: string;
  name: string;
  ai_school_id?: string | null;
  notes?: string | null;
};

// Load a CRM school and ensure it is linked to a school-ai-service UUID.
async function resolveLinkedSchool(
  crmSchoolId: string,
  officialUrl?: string,
): Promise<{ crmSchool: CrmSchoolRow; aiSchoolId: string } | { error: string; status: number }> {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('id, name, ai_school_id, notes')
    .eq('id', crmSchoolId)
    .maybeSingle();
  if (error || !data) return { error: 'CRM school not found', status: 404 };
  const linked = await ensureLinkedAiSchool(data as CrmSchoolRow, officialUrl);
  return { crmSchool: data as CrmSchoolRow, aiSchoolId: linked.aiSchoolId };
}

// ─── Health (authenticated) ──────────────────────────────────────────
router.get('/health', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (_req, res) => {
  try {
    const report = await ai.health();
    res.json(report);
  } catch (error) {
    mapAiError(error, res);
  }
});

// ─── Ensure CRM school ↔ Python school link ──────────────────────────
router.post('/ensure-school', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { crmSchoolId, name, officialUrl } = req.body || {};
    if (!crmSchoolId && !name) {
      return res.status(400).json({ error: 'crmSchoolId or name is required' });
    }
    let crmSchool: { id: string; name: string; ai_school_id?: string | null } | null = null;
    if (crmSchoolId) {
      const { data, error } = await supabaseAdmin
        .from('schools')
        .select('id, name, ai_school_id, notes')
        .eq('id', crmSchoolId)
        .maybeSingle();
      if (error || !data) return res.status(404).json({ error: 'CRM school not found' });
      crmSchool = data;
    } else {
      const trimmed = String(name).trim();
      const { data: existing } = await supabaseAdmin
        .from('schools')
        .select('id, name, ai_school_id, notes')
        .ilike('name', trimmed)
        .limit(1)
        .maybeSingle();
      if (existing) {
        crmSchool = existing;
      } else {
        const { data: created, error } = await supabaseAdmin
          .from('schools')
          .insert({ name: trimmed, location: 'Unknown' })
          .select('id, name, ai_school_id, notes')
          .single();
        if (error || !created) return res.status(400).json({ error: error?.message || 'Failed to create CRM school' });
        crmSchool = created;
      }
    }
    const linked = await ensureLinkedAiSchool(crmSchool!, officialUrl);
    res.json({
      crmSchoolId: crmSchool!.id,
      name: crmSchool!.name,
      aiSchoolId: linked.aiSchoolId,
      created: linked.created,
    });
  } catch (error) {
    mapAiError(error, res);
  }
});

// ─── Document upload (multipart) ─────────────────────────────────────
router.post(
  '/schools/:aiSchoolId/documents',
  authorize('ADMIN', 'MENTOR_MANAGER'),
  upload.single('file'),
  async (req: AuthRequest, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'file is required' });
      const forceRefresh = String(req.query.force_refresh || '') === 'true';
      const result = await ai.uploadDocument(
        req.params.aiSchoolId,
        file.buffer,
        file.originalname || 'document.pdf',
        forceRefresh,
      );
      res.json(result);
    } catch (error) {
      mapAiError(error, res);
    }
  },
);

router.post('/schools/:aiSchoolId/research', authorize('ADMIN', 'MENTOR_MANAGER'), async (req, res) => {
  try {
    const forceRefresh = String(req.query.force_refresh || '') === 'true';
    res.json(await ai.enqueueResearch(req.params.aiSchoolId, forceRefresh));
  } catch (error) {
    mapAiError(error, res);
  }
});

// Targeted crawl of an admin-provided URL (e.g. the school's official page).
router.post('/schools/:aiSchoolId/crawl-url', authorize('ADMIN', 'MENTOR_MANAGER'), async (req, res) => {
  try {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url) return res.status(400).json({ error: 'url is required' });
    const forceRefresh = String(req.query.force_refresh || '') === 'true';
    res.json(await ai.crawlUrl(req.params.aiSchoolId, url, forceRefresh));
  } catch (error) {
    mapAiError(error, res);
  }
});

// List documents + crawled web sources for a school.
router.get('/schools/:aiSchoolId/sources', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req, res) => {
  try {
    res.json(await ai.listSchoolSources(req.params.aiSchoolId));
  } catch (error) {
    mapAiError(error, res);
  }
});

router.get('/jobs/:jobId', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req, res) => {
  try {
    res.json(await ai.getJob(req.params.jobId));
  } catch (error) {
    mapAiError(error, res);
  }
});

router.get('/jobs', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const schoolId = typeof req.query.school_id === 'string' ? req.query.school_id : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await ai.listJobs({
      status: status as any,
      schoolId,
      limit,
    }));
  } catch (error) {
    mapAiError(error, res);
  }
});

router.post('/schools/:aiSchoolId/rubric/generate', authorize('ADMIN', 'MENTOR_MANAGER'), async (req, res) => {
  try {
    res.json(await ai.generateRubric(req.params.aiSchoolId));
  } catch (error) {
    mapAiError(error, res);
  }
});

router.get('/schools/:aiSchoolId/rubric', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req, res) => {
  try {
    res.json(await ai.getRubric(req.params.aiSchoolId));
  } catch (error) {
    mapAiError(error, res);
  }
});

router.post('/schools/:aiSchoolId/rubric/approve', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res) => {
  try {
    const editor = (req.body?.editor as string) || req.user?.email || req.user?.id || 'crm-admin';
    res.json(await ai.approveRubric(req.params.aiSchoolId, editor));
  } catch (error) {
    mapAiError(error, res);
  }
});

router.post('/schools/:aiSchoolId/score', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res) => {
  try {
    const { studentId, attributes } = req.body || {};
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });
    let attrs = attributes && typeof attributes === 'object' ? attributes : {};
    if (!Object.keys(attrs).length) {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('*')
        .eq('id', studentId)
        .maybeSingle();
      if (profile) attrs = profileToAttributes(profile);
    }
    res.json(await ai.scoreStudent(req.params.aiSchoolId, String(studentId), attrs));
  } catch (error) {
    mapAiError(error, res);
  }
});

// ─── Cached facts + rubric snapshot (CRM-school keyed) ───────────────
// Fast read straight from Supabase; does not call Python.
router.get('/schools/:crmSchoolId/facts-cache', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('school_ai_facts_cache')
      .select('*')
      .eq('school_id', req.params.crmSchoolId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ cache: data || null });
  } catch (error) {
    mapAiError(error, res);
  }
});

// Refresh facts + rubric from Python and upsert the Supabase cache.
router.post('/schools/:crmSchoolId/facts-refresh', authorize('ADMIN', 'MENTOR_MANAGER'), async (req, res) => {
  try {
    const officialUrl = typeof req.body?.officialUrl === 'string' ? req.body.officialUrl : undefined;
    const resolved = await resolveLinkedSchool(req.params.crmSchoolId, officialUrl);
    if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });
    const { crmSchool, aiSchoolId } = resolved;

    const [factsResult, rubricResult] = await Promise.allSettled([
      ai.getSchoolFacts(aiSchoolId),
      ai.getRubric(aiSchoolId),
    ]);
    const facts = factsResult.status === 'fulfilled' ? factsResult.value.facts : [];
    const rubric = rubricResult.status === 'fulfilled' ? rubricResult.value : null;
    const rubricStatus = rubric && typeof rubric === 'object' && 'rubric_status' in rubric
      ? String((rubric as { rubric_status: unknown }).rubric_status)
      : null;

    const now = new Date().toISOString();
    const row = {
      school_id: crmSchool.id,
      ai_school_id: aiSchoolId,
      raw_facts: facts,
      rubric,
      fact_count: Array.isArray(facts) ? facts.length : 0,
      rubric_status: rubricStatus,
      refreshed_at: now,
      updated_at: now,
    };
    const { data, error } = await supabaseAdmin
      .from('school_ai_facts_cache')
      .upsert(row, { onConflict: 'school_id' })
      .select('*')
      .single();
    if (error) {
      console.warn('Could not persist facts cache (apply migration 060):', error.message);
      return res.json({ cache: row, persisted: false });
    }
    res.json({ cache: data, persisted: true });
  } catch (error) {
    mapAiError(error, res);
  }
});

// ─── Persisted student ↔ school comparisons ──────────────────────────
// Read saved fit scores for a student (fast, from Supabase).
router.get('/students/:studentId/scores', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('school_ai_scores')
      .select('*, schools(id, name)')
      .eq('student_id', req.params.studentId)
      .order('score', { ascending: false, nullsFirst: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ scores: data || [] });
  } catch (error) {
    mapAiError(error, res);
  }
});

// Re-run a single school↔student comparison via Python and upsert it.
router.post('/schools/:crmSchoolId/score-refresh', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res) => {
  try {
    const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId : '';
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });
    const resolved = await resolveLinkedSchool(req.params.crmSchoolId);
    if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });
    const { crmSchool, aiSchoolId } = resolved;

    let attrs: Record<string, unknown> = {};
    const { data: profile } = await supabaseAdmin
      .from('student_profiles')
      .select('*')
      .eq('id', studentId)
      .maybeSingle();
    if (profile) attrs = profileToAttributes(profile);

    const result = await ai.scoreStudent(aiSchoolId, studentId, attrs);
    const probs = result.probabilities;
    const now = new Date().toISOString();
    const row = {
      school_id: crmSchool.id,
      student_id: studentId,
      ai_school_id: aiSchoolId,
      score: Number(result.score),
      score_kind: result.score_kind,
      reasoning: result.reasoning,
      per_factor_breakdown: result.per_factor_breakdown ?? [],
      skipped: result.skipped ?? [],
      attributes_used: attrs,
      scoring_run_id: result.scoring_run_id ?? null,
      interview_probability: probs?.interview_probability ?? null,
      acceptance_probability: probs?.acceptance_probability ?? null,
      waitlist_probability: probs?.waitlist_probability ?? null,
      reject_probability: probs?.reject_probability ?? null,
      probability_kind: probs?.probability_kind ?? null,
      updated_at: now,
    };
    const { data, error } = await supabaseAdmin
      .from('school_ai_scores')
      .upsert(row, { onConflict: 'school_id,student_id' })
      .select('*')
      .single();
    if (error) {
      console.warn('Could not persist score (apply migrations 060/061):', error.message);
      return res.json({ score: row, persisted: false });
    }
    res.json({ score: data, persisted: true });
  } catch (error) {
    mapAiError(error, res);
  }
});

/**
 * Build a strategic selection plan draft from fit scores on the student's school board.
 * Requires approved Python rubrics (and linked ai_school_id) for each scored school.
 */
router.post('/selection-plan', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { studentId, schoolIds, autoLink = true } = req.body || {};
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('student_profiles')
      .select('*')
      .eq('id', studentId)
      .maybeSingle();
    if (profileErr || !profile) return res.status(404).json({ error: 'Student profile not found' });

    let boardQuery = supabaseAdmin
      .from('student_schools')
      .select('school_id, category, schools(id, name, ai_school_id, notes, avg_gpa, dat_avg)')
      .eq('student_id', studentId);
    if (Array.isArray(schoolIds) && schoolIds.length) {
      boardQuery = boardQuery.in('school_id', schoolIds);
    }
    const { data: board, error: boardErr } = await boardQuery;
    if (boardErr) return res.status(500).json({ error: boardErr.message });
    if (!board?.length) {
      return res.status(400).json({
        error: 'Student has no schools on their board. Add schools in Plan → Schools first.',
      });
    }

    const attributes = profileToAttributes(profile);
    const scores: Array<{
      crmSchoolId: string;
      name: string;
      category: string;
      aiSchoolId: string | null;
      score: number | null;
      reasoning?: string;
      error?: string;
    }> = [];

    for (const row of board as any[]) {
      const school = row.schools;
      if (!school) continue;
      let aiSchoolId: string | null = school.ai_school_id || null;
      if (!aiSchoolId && autoLink) {
        try {
          const linked = await ensureLinkedAiSchool(school);
          aiSchoolId = linked.aiSchoolId;
        } catch (err) {
          scores.push({
            crmSchoolId: school.id,
            name: school.name,
            category: row.category,
            aiSchoolId: null,
            score: null,
            error: err instanceof Error ? err.message : 'Failed to link AI school',
          });
          continue;
        }
      }
      if (!aiSchoolId) {
        scores.push({
          crmSchoolId: school.id,
          name: school.name,
          category: row.category,
          aiSchoolId: null,
          score: null,
          error: 'Not linked to school-ai-service (set ai_school_id or enable autoLink)',
        });
        continue;
      }
      try {
        const result = await ai.scoreStudent(aiSchoolId, String(studentId), attributes);
        scores.push({
          crmSchoolId: school.id,
          name: school.name,
          category: row.category,
          aiSchoolId,
          score: Number(result.score),
          reasoning: result.reasoning,
        });
      } catch (err) {
        const msg = err instanceof SchoolAiClientError ? err.message : (err instanceof Error ? err.message : 'Score failed');
        scores.push({
          crmSchoolId: school.id,
          name: school.name,
          category: row.category,
          aiSchoolId,
          score: null,
          error: msg,
        });
      }
    }

    const scored = scores.filter((s) => s.score != null) as Array<typeof scores[number] & { score: number }>;
    const avg =
      scored.length > 0
        ? Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length)
        : 50;

    const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 3);
    const weak = [...scored].sort((a, b) => a.score - b.score).slice(0, 3);

    const strengths = top.map((s) => `${s.name}: fit score ${s.score}/100 (${s.category})`);
    const gaps = [
      ...weak.filter((s) => s.score < 60).map((s) => `${s.name}: lower fit (${s.score}/100) — review gaps vs rubric`),
      ...scores.filter((s) => s.error).map((s) => `${s.name}: ${s.error}`),
    ];
    if (!gaps.length) gaps.push('No critical fit gaps detected from scored schools.');

    const snapshotParts = [
      `AI fit scoring across ${scored.length} of ${scores.length} board schools (deterministic fit score, not acceptance probability).`,
      top[0] ? `Strongest current fit: ${top[0].name} (${top[0].score}/100).` : 'No approved rubrics scored yet — generate & approve school rubrics in school-ai-service first.',
      Object.keys(attributes).length
        ? `Profile signals used: ${Object.keys(attributes).join(', ')}.`
        : 'Student profile has limited numeric attributes; scores may skip many factors.',
    ];

    const draft = {
      snapshot: snapshotParts.join(' '),
      overallScore: avg,
      improvementLeverageScore: Math.max(0, Math.min(100, 100 - avg + 20)),
      kpis: {
        academics: kpiFromScore(Number(profile.gpa || profile.sgpa || 0) >= 3.5 ? 75 : Number(profile.gpa || 0) >= 3.2 ? 55 : 35),
        experienceDepth: 'Moderate' as const,
        leadership: 'Moderate' as const,
        shadowing: kpiFromScore(Number(profile.shadowing_hours || 0) >= 100 ? 80 : Number(profile.shadowing_hours || 0) >= 50 ? 55 : 35),
      },
      strengths: strengths.length ? strengths : ['Add approved school rubrics to surface strengths.'],
      gaps,
      roadmap: {
        phase1: ['Confirm school board Reach / Target / Safety categories'],
        phase2: scored.filter((s) => s.score >= 70).slice(0, 3).map((s) => `Prioritize application prep for ${s.name}`),
        phase3: weak.slice(0, 2).map((s) => `Close gaps for ${s.name} (fit ${s.score})`),
        phase4: ['Re-score after profile updates (GPA / DAT / shadowing)'],
      },
      leverageActions: top.slice(0, 2).map((s) => ({
        title: `Lean into ${s.name}`,
        description: s.reasoning?.slice(0, 280) || `Fit score ${s.score}/100 on approved rubric.`,
        impact: s.score >= 75 ? 'High' : 'Moderate',
      })),
      riskFactors: weak.filter((s) => s.score < 55).slice(0, 3).map((s) => ({
        factor: s.name,
        severity: s.score < 40 ? 'High' : 'Medium',
        description: `Lower fit score (${s.score}/100) vs current board category ${s.category}.`,
        mitigation: 'Compare skipped factors in the score breakdown and update the student profile or school list.',
      })),
    };

    if (!draft.roadmap.phase2.length) draft.roadmap.phase2 = ['Generate & approve rubrics for board schools in school-ai-service'];
    if (!draft.roadmap.phase3.length) draft.roadmap.phase3 = ['Re-run AI plan after rubrics are approved'];
    if (!draft.leverageActions.length) {
      draft.leverageActions = [{
        title: 'Complete school research pipeline',
        description: 'Upload admissions docs → research → generate rubric → approve, then re-run this plan.',
        impact: 'High',
      }];
    }
    if (!draft.riskFactors.length) {
      draft.riskFactors = [{
        factor: 'Coverage',
        severity: 'Low',
        description: 'Few or no schools scored successfully.',
        mitigation: 'Link CRM schools (ai_school_id) and approve Python rubrics.',
      }];
    }

    res.json({
      studentId,
      attributesUsed: attributes,
      scores,
      scoredCount: scored.length,
      draft,
    });
  } catch (error) {
    mapAiError(error, res);
  }
});

export const schoolAiRouter = router;
