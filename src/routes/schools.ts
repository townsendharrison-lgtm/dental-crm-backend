import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/schools ────────────────────────────────────────────────
// Get all schools in the directory (supports ?search= query)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { search } = req.query;

    let query = supabaseAdmin
      .from('schools')
      .select('*')
      .order('name', { ascending: true });

    if (search) {
      const searchStr = search as string;
      // Filter by name or location (using OR search)
      query = query.or(`name.ilike.%${searchStr}%,location.ilike.%${searchStr}%`);
    }

    const { data: schools, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ schools: schools || [] });
  } catch (error: any) {
    console.error('Fetch schools error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/schools/:id ────────────────────────────────────────────
// Fetch details of a single school
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: school, error } = await supabaseAdmin
      .from('schools')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json(school);
  } catch (error: any) {
    console.error('Fetch school details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/schools/ensure ────────────────────────────────────────
// Find a school by name (case-insensitive) or create it. Any authenticated user.
// Used when adding catalog/sheet schools to a student list or logging applications.
router.post('/ensure', async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      location = 'Unknown',
      strengthScoreAvg = 0,
      datAvg = 0,
      avgGpa = 0,
      acceptanceRate,
      isAcceptanceRate,
      oosAcceptanceRate,
      ccCredits = true,
      tuition,
      notes,
      inStateEnrollment,
      outOfStateEnrollment,
      maleEnrollment,
      femaleEnrollment,
      ethnicity = {},
      minDat5th,
      minCgpa5th,
    } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'School name is required' });
    }

    const trimmedName = name.trim();

    const { data: existing, error: findErr } = await supabaseAdmin
      .from('schools')
      .select('*')
      .ilike('name', trimmedName)
      .limit(1)
      .maybeSingle();

    if (findErr) {
      return res.status(500).json({ error: findErr.message });
    }

    if (existing) {
      return res.json(existing);
    }

    const { data: created, error: createErr } = await supabaseAdmin
      .from('schools')
      .insert({
        name: trimmedName,
        location: (location && String(location).trim()) || 'Unknown',
        strength_score_avg: strengthScoreAvg || 0,
        dat_avg: datAvg || 0,
        avg_gpa: avgGpa || 0,
        acceptance_rate: acceptanceRate ?? null,
        is_acceptance_rate: isAcceptanceRate ?? null,
        oos_acceptance_rate: oosAcceptanceRate ?? null,
        cc_credits: ccCredits !== false,
        tuition: tuition || null,
        notes: notes || null,
        in_state_enrollment: inStateEnrollment ?? null,
        out_of_state_enrollment: outOfStateEnrollment ?? null,
        male_enrollment: maleEnrollment ?? null,
        female_enrollment: femaleEnrollment ?? null,
        ethnicity: ethnicity || {},
        min_dat_5th: minDat5th ?? null,
        min_cgpa_5th: minCgpa5th ?? null,
      })
      .select()
      .single();

    if (createErr) {
      // Race: another request created the same name
      if (createErr.code === '23505') {
        const { data: raced } = await supabaseAdmin
          .from('schools')
          .select('*')
          .ilike('name', trimmedName)
          .limit(1)
          .maybeSingle();
        if (raced) return res.json(raced);
      }
      return res.status(400).json({ error: createErr.message });
    }

    res.status(201).json(created);
  } catch (error: any) {
    console.error('Ensure school error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/schools ───────────────────────────────────────────────
// Create a new school profile (Admin only)
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      location,
      strengthScoreAvg = 0,
      datAvg = 0.0,
      avgGpa = 0.0,
      acceptanceRate,
      isAcceptanceRate,
      oosAcceptanceRate,
      ccCredits = true,
      tuition,
      notes,
      inStateEnrollment,
      outOfStateEnrollment,
      maleEnrollment,
      femaleEnrollment,
      ethnicity = {},
      minDat5th,
      minCgpa5th
    } = req.body;

    if (!name || !location) {
      return res.status(400).json({ error: 'Name and location are required' });
    }

    const { data: newSchool, error } = await supabaseAdmin
      .from('schools')
      .insert({
        name,
        location,
        strength_score_avg: strengthScoreAvg,
        dat_avg: datAvg,
        avg_gpa: avgGpa,
        acceptance_rate: acceptanceRate || null,
        is_acceptance_rate: isAcceptanceRate || null,
        oos_acceptance_rate: oosAcceptanceRate || null,
        cc_credits: ccCredits,
        tuition: tuition || null,
        notes: notes || null,
        in_state_enrollment: inStateEnrollment || null,
        out_of_state_enrollment: outOfStateEnrollment || null,
        male_enrollment: maleEnrollment || null,
        female_enrollment: femaleEnrollment || null,
        ethnicity: ethnicity || {},
        min_dat_5th: minDat5th || null,
        min_cgpa_5th: minCgpa5th || null
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newSchool);
  } catch (error: any) {
    console.error('Create school profile error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/schools/:id ────────────────────────────────────────────
// Update school profile details (Admin only)
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('schools')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'School not found' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.location !== undefined) dbUpdates.location = updates.location;
    if (updates.strengthScoreAvg !== undefined) dbUpdates.strength_score_avg = updates.strengthScoreAvg;
    if (updates.datAvg !== undefined) dbUpdates.dat_avg = updates.datAvg;
    if (updates.avgGpa !== undefined) dbUpdates.avg_gpa = updates.avgGpa;
    if (updates.acceptanceRate !== undefined) dbUpdates.acceptance_rate = updates.acceptanceRate;
    if (updates.isAcceptanceRate !== undefined) dbUpdates.is_acceptance_rate = updates.isAcceptanceRate;
    if (updates.oosAcceptanceRate !== undefined) dbUpdates.oos_acceptance_rate = updates.oosAcceptanceRate;
    if (updates.ccCredits !== undefined) dbUpdates.cc_credits = updates.ccCredits;
    if (updates.tuition !== undefined) dbUpdates.tuition = updates.tuition;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    if (updates.inStateEnrollment !== undefined) dbUpdates.in_state_enrollment = updates.inStateEnrollment;
    if (updates.outOfStateEnrollment !== undefined) dbUpdates.out_of_state_enrollment = updates.outOfStateEnrollment;
    if (updates.maleEnrollment !== undefined) dbUpdates.male_enrollment = updates.maleEnrollment;
    if (updates.femaleEnrollment !== undefined) dbUpdates.female_enrollment = updates.femaleEnrollment;
    if (updates.ethnicity !== undefined) dbUpdates.ethnicity = updates.ethnicity;
    if (updates.minDat5th !== undefined) dbUpdates.min_dat_5th = updates.minDat5th;
    if (updates.minCgpa5th !== undefined) dbUpdates.min_cgpa_5th = updates.minCgpa5th;

    const { data: updated, error } = await supabaseAdmin
      .from('schools')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update school profile error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/schools/:id ─────────────────────────────────────────
// Delete school profile (Admin only)
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('schools')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'School not found' });
    }

    const { error } = await supabaseAdmin
      .from('schools')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'School profile deleted successfully from directory' });
  } catch (error: any) {
    console.error('Delete school error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const schoolsRouter = router;
