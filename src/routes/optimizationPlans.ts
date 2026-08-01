import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

const EXTERNAL_EMAIL_SUFFIX = '@school-selection.local';

function isLegacyExternalEmail(email?: string | null) {
  return !!email && email.toLowerCase().endsWith(EXTERNAL_EMAIL_SUFFIX);
}

function planPayloadFromBody(body: any) {
  const payload: Record<string, unknown> = {
    snapshot: body.snapshot,
    overall_score: body.overallScore ?? body.overall_score ?? 0,
    improvement_leverage_score:
      body.improvementLeverageScore ?? body.improvement_leverage_score ?? 0,
    kpis: body.kpis ?? {},
    roadmap: body.roadmap ?? {},
    risk_factors: body.riskFactors ?? body.risk_factors ?? [],
    leverage_actions: body.leverageActions ?? body.leverage_actions ?? [],
    strengths: body.strengths ?? [],
    gaps: body.gaps ?? [],
    school_board: body.schoolBoard ?? body.school_board ?? null,
    updated_at: new Date().toISOString(),
  };

  if (body.categories !== undefined) {
    payload.categories =
      body.categories && typeof body.categories === 'object' ? body.categories : {};
  }
  if (body.manualDexterity !== undefined || body.manual_dexterity !== undefined) {
    payload.manual_dexterity = body.manualDexterity ?? body.manual_dexterity ?? null;
  }

  return payload;
}

function mapPlanRow(plan: any) {
  if (!plan) return plan;
  return {
    ...plan,
    studentId: plan.student_id,
    externalId: plan.external_id,
    schoolBoard: plan.school_board ?? null,
    overallScore: plan.overall_score,
    improvementLeverageScore: plan.improvement_leverage_score,
    riskFactors: plan.risk_factors ?? [],
    leverageActions: plan.leverage_actions ?? [],
    categories: plan.categories ?? {},
    manualDexterity: plan.manual_dexterity ?? null,
  };
}

// All routes require authentication
router.use(authenticate);

// ─── GET /api/optimization-plans ──────────────────────────────────────
// - Staff + ?list=1 → all plans with student/external summary
// - Otherwise → one plan (?studentId= or ?externalId= required for staff)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId, externalId, list } = req.query;

    // Admin overview: list all created school-selection / optimization reports
    if (
      (list === '1' || list === 'true') &&
      (role === 'ADMIN' || role === 'MENTOR_MANAGER')
    ) {
      const { data: plans, error } = await supabaseAdmin
        .from('optimization_plans')
        .select('*')
        .order('updated_at', { ascending: false });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const rows = plans || [];
      const studentIds = Array.from(
        new Set(rows.map((p) => p.student_id).filter(Boolean)),
      ) as string[];
      const externalIds = Array.from(
        new Set(rows.map((p) => p.external_id).filter(Boolean)),
      ) as string[];

      let usersById = new Map<
        string,
        { id: string; name: string; email: string; avatar?: string | null }
      >();
      let externalsById = new Map<string, { id: string; name: string }>();

      if (studentIds.length > 0) {
        const { data: users } = await supabaseAdmin
          .from('users')
          .select('id, name, email, avatar')
          .in('id', studentIds);
        usersById = new Map((users || []).map((u) => [u.id, u]));
      }

      if (externalIds.length > 0) {
        const { data: externals } = await supabaseAdmin
          .from('school_selection_externals')
          .select('id, name')
          .in('id', externalIds);
        externalsById = new Map((externals || []).map((e) => [e.id, e]));
      }

      return res.json(
        rows.map((plan) => {
          if (plan.external_id) {
            const ext = externalsById.get(plan.external_id);
            return {
              ...plan,
              studentId: null,
              externalId: plan.external_id,
              student: {
                id: plan.external_id,
                name: ext?.name || 'External customer',
                email: '',
                avatar: null,
                isExternal: true,
              },
            };
          }

          const user = usersById.get(plan.student_id);
          const email = user?.email || '';
          return {
            ...plan,
            studentId: plan.student_id,
            externalId: null,
            student: user
              ? {
                  id: user.id,
                  name: user.name || 'Unnamed student',
                  email,
                  avatar: user.avatar || null,
                  isExternal: isLegacyExternalEmail(email),
                }
              : {
                  id: plan.student_id,
                  name: 'Unknown student',
                  email: '',
                  avatar: null,
                  isExternal: false,
                },
          };
        }),
      );
    }

    if (role !== 'STUDENT' && externalId) {
      const { data: plan, error } = await supabaseAdmin
        .from('optimization_plans')
        .select('*')
        .eq('external_id', externalId as string)
        .maybeSingle();

      if (error) {
        return res.status(500).json({ error: error.message });
      }
      if (!plan) {
        return res.status(404).json({ error: 'No optimization plan found for this external customer' });
      }
      return res.json(mapPlanRow(plan));
    }

    let targetStudentId = userId;

    if (role !== 'STUDENT') {
      if (!studentId) {
        return res.status(400).json({
          error: 'studentId or externalId query parameter is required for staff',
        });
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

    res.json(mapPlanRow(plan));
  } catch (error: any) {
    console.error('Fetch optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/optimization-plans ─────────────────────────────────────
// Create or Upsert — linked student OR external customer (no CRM account)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const {
      studentId,
      externalId,
      externalName,
      snapshot,
    } = req.body;

    if (!snapshot) {
      return res.status(400).json({ error: 'snapshot is required' });
    }

    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot create optimization plans' });
    }

    const base = planPayloadFromBody(req.body);
    const wantsExternal =
      !!externalId ||
      (typeof externalName === 'string' && externalName.trim().length > 0 && !studentId);

    // ── External customer plan (no auth.users / no student row) ─────────
    if (wantsExternal) {
      if (role === 'MENTOR') {
        return res.status(403).json({
          error: 'Mentors can only create plans for assigned students',
        });
      }

      const name =
        typeof externalName === 'string' ? externalName.trim() : '';
      let targetExternalId =
        typeof externalId === 'string' && externalId.trim() ? externalId.trim() : '';

      if (targetExternalId) {
        const { data: existingExt, error: extErr } = await supabaseAdmin
          .from('school_selection_externals')
          .select('id, name')
          .eq('id', targetExternalId)
          .maybeSingle();
        if (extErr || !existingExt) {
          return res.status(404).json({ error: 'External customer not found' });
        }
        if (name && name !== existingExt.name) {
          await supabaseAdmin
            .from('school_selection_externals')
            .update({ name, updated_at: new Date().toISOString() })
            .eq('id', targetExternalId);
        }
      } else {
        if (!name) {
          return res.status(400).json({ error: 'externalName is required for external plans' });
        }
        const { data: createdExt, error: createExtErr } = await supabaseAdmin
          .from('school_selection_externals')
          .insert({
            name,
            created_by: userId,
          })
          .select('id')
          .single();
        if (createExtErr || !createdExt) {
          return res.status(400).json({
            error: createExtErr?.message || 'Failed to create external customer',
          });
        }
        targetExternalId = createdExt.id;
      }

      const { data: plan, error } = await supabaseAdmin
        .from('optimization_plans')
        .upsert(
          {
            ...base,
            student_id: null,
            external_id: targetExternalId,
          },
          { onConflict: 'external_id' },
        )
        .select()
        .single();

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      return res.status(201).json(mapPlanRow(plan));
    }

    // ── Linked CRM student plan ─────────────────────────────────────────
    if (!studentId) {
      return res.status(400).json({
        error: 'studentId or externalName is required',
      });
    }

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

    // Block saving new plans onto legacy shell "students"
    const { data: subjectUser } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('id', studentId)
      .maybeSingle();
    if (subjectUser && isLegacyExternalEmail(subjectUser.email)) {
      return res.status(400).json({
        error:
          'This account is a legacy external shell. Create a new external plan instead of linking a CRM student.',
      });
    }

    const { data: plan, error } = await supabaseAdmin
      .from('optimization_plans')
      .upsert(
        {
          ...base,
          student_id: studentId,
          external_id: null,
          school_board: null,
        },
        { onConflict: 'student_id' },
      )
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(mapPlanRow(plan));
  } catch (error: any) {
    console.error('Upsert optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/optimization-plans/:id ──────────────────────────────────
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

    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot modify optimization plans' });
    }

    if (role === 'MENTOR') {
      if (!existing.student_id) {
        return res.status(403).json({ error: 'Mentors cannot modify external plans' });
      }
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
    if (updates.improvementLeverageScore !== undefined) {
      dbUpdates.improvement_leverage_score = updates.improvementLeverageScore;
    }
    if (updates.kpis !== undefined) dbUpdates.kpis = updates.kpis;
    if (updates.roadmap !== undefined) dbUpdates.roadmap = updates.roadmap;
    if (updates.riskFactors !== undefined) dbUpdates.risk_factors = updates.riskFactors;
    if (updates.leverageActions !== undefined) dbUpdates.leverage_actions = updates.leverageActions;
    if (updates.strengths !== undefined) dbUpdates.strengths = updates.strengths;
    if (updates.gaps !== undefined) dbUpdates.gaps = updates.gaps;
    if (updates.schoolBoard !== undefined || updates.school_board !== undefined) {
      dbUpdates.school_board = updates.schoolBoard ?? updates.school_board;
    }
    if (updates.categories !== undefined) {
      dbUpdates.categories =
        updates.categories && typeof updates.categories === 'object' ? updates.categories : {};
    }
    if (updates.manualDexterity !== undefined || updates.manual_dexterity !== undefined) {
      dbUpdates.manual_dexterity = updates.manualDexterity ?? updates.manual_dexterity ?? null;
    }
    if (typeof updates.externalName === 'string' && existing.external_id) {
      const name = updates.externalName.trim();
      if (name) {
        await supabaseAdmin
          .from('school_selection_externals')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', existing.external_id);
      }
    }

    const { data: updated, error } = await supabaseAdmin
      .from('optimization_plans')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(mapPlanRow(updated));
  } catch (error: any) {
    console.error('Update optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/optimization-plans/:id ───────────────────────────────
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

    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (role === 'MENTOR') {
      if (!existing.student_id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', existing.student_id)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const externalId = existing.external_id as string | null;

    const { error } = await supabaseAdmin
      .from('optimization_plans')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Cascade removes plan via FK; also remove external customer row if present
    if (externalId) {
      await supabaseAdmin
        .from('school_selection_externals')
        .delete()
        .eq('id', externalId);
    }

    res.json({ message: 'Optimization plan deleted successfully' });
  } catch (error: any) {
    console.error('Delete optimization plan error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const optimizationPlansRouter = router;
