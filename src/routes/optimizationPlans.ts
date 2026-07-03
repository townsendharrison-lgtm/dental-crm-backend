import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/optimization-plans ──────────────────────────────────────
// Fetch a student's active optimization plan (includes score, KPIs, roadmap, and risks)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.query;

    let targetStudentId = userId;

    if (role !== 'STUDENT') {
      if (!studentId) {
        return res.status(400).json({ error: 'studentId query parameter is required for staff' });
      }
      targetStudentId = studentId as string;
    }

    // Verify access if caller is mentor
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', targetStudentId)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'Access denied. Student is not assigned to you.' });
      }
    }

    const { data: plan, error } = await supabaseAdmin
      .from('optimization_plans')
      .select('*')
      .eq('student_id', targetStudentId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!plan) {
      return res.status(404).json({ error: 'No optimization plan found for this student' });
    }

    res.json(plan);
  } catch (error: any) {
    console.error('Fetch optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/optimization-plans ─────────────────────────────────────
// Create or Upsert a student's optimization plan (Admins & assigned Mentors only)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const {
      studentId,
      snapshot,
      overallScore = 0,
      improvementLeverageScore = 0,
      kpis = {},
      roadmap = {},
      riskFactors = [],
      leverageActions = [],
      strengths = [],
      gaps = []
    } = req.body;

    if (!studentId || !snapshot) {
      return res.status(400).json({ error: 'studentId and snapshot are required' });
    }

    // Verify staff rights
    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot create optimization plans' });
    }

    // Verify assignment if Mentor is creating the plan
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', studentId)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'You are not assigned to this student' });
      }
    }

    // Upsert optimization plan (inserts or updates based on student_id unique constraint)
    const { data: plan, error } = await supabaseAdmin
      .from('optimization_plans')
      .upsert(
        {
          student_id: studentId,
          snapshot,
          overall_score: overallScore,
          improvement_leverage_score: improvementLeverageScore,
          kpis,
          roadmap,
          risk_factors: riskFactors,
          leverage_actions: leverageActions,
          strengths,
          gaps,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'student_id' }
      )
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(plan);
  } catch (error: any) {
    console.error('Upsert optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/optimization-plans/:id ──────────────────────────────────
// Update details of an optimization plan (Admins & assigned Mentors only)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('optimization_plans')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Optimization plan not found' });
    }

    // Verify staff permissions
    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot modify optimization plans' });
    }

    // Verify assignment if Mentor is updating the plan
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', existing.student_id)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'You are not assigned to this student' });
      }
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.snapshot !== undefined) dbUpdates.snapshot = updates.snapshot;
    if (updates.overallScore !== undefined) dbUpdates.overall_score = updates.overallScore;
    if (updates.improvementLeverageScore !== undefined) dbUpdates.improvement_leverage_score = updates.improvementLeverageScore;
    if (updates.kpis !== undefined) dbUpdates.kpis = updates.kpis;
    if (updates.roadmap !== undefined) dbUpdates.roadmap = updates.roadmap;
    if (updates.riskFactors !== undefined) dbUpdates.risk_factors = updates.riskFactors;
    if (updates.leverageActions !== undefined) dbUpdates.leverage_actions = updates.leverageActions;
    if (updates.strengths !== undefined) dbUpdates.strengths = updates.strengths;
    if (updates.gaps !== undefined) dbUpdates.gaps = updates.gaps;

    const { data: updated, error } = await supabaseAdmin
      .from('optimization_plans')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/optimization-plans/:id ───────────────────────────────
// Delete an optimization plan (Admins & assigned Mentors only)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('optimization_plans')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Optimization plan not found' });
    }

    // Verify staff permissions
    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Verify assignment if Mentor is deleting the plan
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', existing.student_id)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { error } = await supabaseAdmin
      .from('optimization_plans')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Optimization plan deleted successfully' });
  } catch (error: any) {
    console.error('Delete optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const optimizationPlansRouter = router;
