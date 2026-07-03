import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/research-cases ─────────────────────────────────────────
// Fetch past applicant research cases with filter parameters (restricted to staff: ADMIN, MENTOR_MANAGER, MENTOR)
router.get('/', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { minGpa, maxGpa, minDat, school, cycle } = req.query;

    let dbQuery = supabaseAdmin
      .from('research_cases')
      .select('*')
      .order('gpa', { ascending: false });

    if (minGpa) {
      dbQuery = dbQuery.gte('gpa', parseFloat(minGpa as string));
    }
    if (maxGpa) {
      dbQuery = dbQuery.lte('gpa', parseFloat(maxGpa as string));
    }
    if (minDat) {
      dbQuery = dbQuery.gte('dat_aa', parseInt(minDat as string));
    }
    if (cycle) {
      dbQuery = dbQuery.eq('cycle', cycle as string);
    }

    const { data: cases, error } = await dbQuery;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    let filteredCases = cases || [];

    // Filter in JS to match partial string matches inside arrays (accepted_schools) or matriculated_school
    if (school) {
      const targetSchool = (school as string).toLowerCase();
      filteredCases = filteredCases.filter((c: any) => {
        const matchesMatriculated = c.matriculated_school?.toLowerCase().includes(targetSchool);
        const matchesAccepted = (c.accepted_schools || []).some((s: string) =>
          s.toLowerCase().includes(targetSchool)
        );
        return matchesMatriculated || matchesAccepted;
      });
    }

    res.json({ cases: filteredCases });
  } catch (error: any) {
    console.error('Fetch research cases error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/research-cases/:id ─────────────────────────────────────
// Fetch a single research case details
router.get('/:id', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: c, error } = await supabaseAdmin
      .from('research_cases')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !c) {
      return res.status(404).json({ error: 'Research case not found' });
    }

    res.json(c);
  } catch (error: any) {
    console.error('Fetch research case error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/research-cases ────────────────────────────────────────
// Create a new research case reference profile (Admin only)
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      studentNameAnonymized,
      gpa,
      datAa,
      datTs,
      major,
      undergradInstitution,
      shadowingHours = 0,
      volunteeringHours = 0,
      researchHours = 0,
      acceptedSchools = [],
      rejectedSchools = [],
      matriculatedSchool,
      cycle,
      specialCircumstances
    } = req.body;

    if (!studentNameAnonymized || gpa === undefined || datAa === undefined || datTs === undefined || !cycle) {
      return res.status(400).json({ error: 'studentNameAnonymized, gpa, datAa, datTs, and cycle are required' });
    }

    const { data: newCase, error } = await supabaseAdmin
      .from('research_cases')
      .insert({
        student_name_anonymized: studentNameAnonymized,
        gpa,
        dat_aa: datAa,
        dat_ts: datTs,
        major: major || null,
        undergrad_institution: undergradInstitution || null,
        shadowing_hours: shadowingHours,
        volunteering_hours: volunteeringHours,
        research_hours: researchHours,
        accepted_schools: acceptedSchools,
        rejected_schools: rejectedSchools,
        matriculated_school: matriculatedSchool || null,
        cycle,
        special_circumstances: specialCircumstances || null
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newCase);
  } catch (error: any) {
    console.error('Create research case error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/research-cases/:id ─────────────────────────────────────
// Update research case configuration (Admin only)
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('research_cases')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Research case not found' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.studentNameAnonymized !== undefined) dbUpdates.student_name_anonymized = updates.studentNameAnonymized;
    if (updates.gpa !== undefined) dbUpdates.gpa = updates.gpa;
    if (updates.datAa !== undefined) dbUpdates.dat_aa = updates.datAa;
    if (updates.datTs !== undefined) dbUpdates.dat_ts = updates.datTs;
    if (updates.major !== undefined) dbUpdates.major = updates.major;
    if (updates.undergradInstitution !== undefined) dbUpdates.undergrad_institution = updates.undergradInstitution;
    if (updates.shadowingHours !== undefined) dbUpdates.shadowing_hours = updates.shadowingHours;
    if (updates.volunteeringHours !== undefined) dbUpdates.volunteering_hours = updates.volunteeringHours;
    if (updates.researchHours !== undefined) dbUpdates.research_hours = updates.researchHours;
    if (updates.acceptedSchools !== undefined) dbUpdates.accepted_schools = updates.acceptedSchools;
    if (updates.rejectedSchools !== undefined) dbUpdates.rejected_schools = updates.rejectedSchools;
    if (updates.matriculatedSchool !== undefined) dbUpdates.matriculated_school = updates.matriculatedSchool;
    if (updates.cycle !== undefined) dbUpdates.cycle = updates.cycle;
    if (updates.specialCircumstances !== undefined) dbUpdates.special_circumstances = updates.specialCircumstances;

    const { data: updated, error } = await supabaseAdmin
      .from('research_cases')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update research case error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/research-cases/:id ──────────────────────────────────
// Delete a research case profile (Admin only)
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('research_cases')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Research case not found' });
    }

    const { error } = await supabaseAdmin
      .from('research_cases')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Research case deleted successfully' });
  } catch (error: any) {
    console.error('Delete research case error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const researchCasesRouter = router;
