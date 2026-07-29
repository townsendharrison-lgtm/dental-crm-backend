import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { normalizeDatToLegacy, normalizeDatToModern } from '../services/datScale.js';
import { recalculateStudentStrengthScore } from '../services/recalculateStrengthScore.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

type BenchmarkType =
  | 'PROGRESS'
  | 'STRENGTH_SCORE'
  | 'DAT'
  | 'TASKS_COMPLETED'
  | 'MEETINGS_ATTENDED'
  | 'GPA'
  | 'LOR_COLLECTED'
  | 'VOLUNTEER_HOURS'
  | 'SHADOWING_HOURS';

function hoursFromExperiences(
  experiences: Array<{
    category?: string | null;
    prior_hours?: number | null;
    sessions?: Array<{ duration?: number | null }> | null;
  }>,
  category: string,
): number {
  return experiences
    .filter((e) => e.category === category)
    .reduce((sum, e) => {
      const prior = Number(e.prior_hours) || 0;
      const sessionHrs = (e.sessions || []).reduce(
        (s, sess) => s + (Number(sess.duration) || 0),
        0,
      );
      return sum + prior + sessionHrs;
    }, 0);
}

function datMeetsThreshold(rawDat: number, threshold: number): boolean {
  if (!Number.isFinite(rawDat) || rawDat <= 0) return false;
  if (!Number.isFinite(threshold) || threshold <= 0) return false;

  // Thresholds > 30 are treated as modern (200–600); otherwise legacy (1–30).
  if (threshold > 30) {
    const modern =
      rawDat > 30 ? rawDat : normalizeDatToModern(rawDat);
    return (modern || 0) >= threshold;
  }

  const legacy = normalizeDatToLegacy(rawDat) || 0;
  return legacy >= threshold;
}

// ─── GET /api/badges ──────────────────────────────────────────────────
// Fetch all badge templates in directory
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { data: badges, error } = await supabaseAdmin
      .from('badges')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ badges: badges || [] });
  } catch (error: any) {
    console.error('Fetch badges error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/badges ─────────────────────────────────────────────────
// Create a new badge template definition (Admin only)
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, icon, color, benchmarkType, benchmarkValue } = req.body;

    if (!name || !description || !icon || !color || !benchmarkType || benchmarkValue === undefined) {
      return res.status(400).json({ error: 'All badge template fields are required' });
    }

    const { data: newBadge, error } = await supabaseAdmin
      .from('badges')
      .insert({
        name,
        description,
        icon,
        color,
        benchmark_type: benchmarkType,
        benchmark_value: benchmarkValue
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newBadge);
  } catch (error: any) {
    console.error('Create badge error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/badges/:id ──────────────────────────────────────────────
// Update a badge template definition (Admin only)
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('badges')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Badge template not found' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon;
    if (updates.color !== undefined) dbUpdates.color = updates.color;
    if (updates.benchmarkType !== undefined || updates.benchmark_type !== undefined) {
      dbUpdates.benchmark_type = updates.benchmarkType ?? updates.benchmark_type;
    }
    if (updates.benchmarkValue !== undefined || updates.benchmark_value !== undefined) {
      dbUpdates.benchmark_value = updates.benchmarkValue ?? updates.benchmark_value;
    }

    const { data: updated, error } = await supabaseAdmin
      .from('badges')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update badge error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/badges/:id ───────────────────────────────────────────
// Delete a badge template definition (Admin only)
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('badges')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Badge template not found' });
    }

    const { error } = await supabaseAdmin
      .from('badges')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Badge template deleted successfully' });
  } catch (error: any) {
    console.error('Delete badge error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/badges/student/:studentId ───────────────────────────────
// Get all badges earned by a student
router.get('/student/:studentId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.params;

    // Access control check
    const isOwner = studentId === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', studentId)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: earned, error } = await supabaseAdmin
      .from('student_badges')
      .select('*, badge:badges(*)')
      .eq('student_id', studentId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ badges: earned || [] });
  } catch (error: any) {
    console.error('Fetch student earned badges error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/badges/evaluate/:studentId ─────────────────────────────
// Award qualified badges based on milestones reached
router.post('/evaluate/:studentId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.params;

    // Access control check
    const isOwner = studentId === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', studentId)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Refresh strength score so STRENGTH_SCORE badges use current metrics
    await recalculateStudentStrengthScore(studentId);

    // 1. Fetch student metrics profile
    const { data: profile, error: pErr } = await supabaseAdmin
      .from('student_profiles')
      .select(
        'strength_score, dat_score, dat_aa, progress, gpa, lor_external_service, lor_external_collected',
      )
      .eq('id', studentId)
      .maybeSingle();

    if (pErr || !profile) {
      return res.status(404).json({ error: 'Student profile not found' });
    }

    // 2. Parallel metric fetches for remaining benchmark types
    const [
      { count: tasksCount, error: tErr },
      { count: meetingsCount, error: mErr },
      { data: experiences, error: expErr },
      { count: vaultLorCount, error: lorErr },
      { data: allBadges, error: bErr },
      { data: earned, error: eErr },
    ] = await Promise.all([
      supabaseAdmin
        .from('action_items')
        .select('*', { count: 'exact', head: true })
        .eq('student_id', studentId)
        .eq('status', 'COMPLETED'),
      supabaseAdmin
        .from('meetings')
        .select('*', { count: 'exact', head: true })
        .eq('student_id', studentId)
        .eq('completed', true),
      supabaseAdmin
        .from('experiences')
        .select('category, prior_hours, sessions:experience_sessions(duration)')
        .eq('student_id', studentId),
      supabaseAdmin
        .from('lor_requests')
        .select('*', { count: 'exact', head: true })
        .eq('student_id', studentId)
        .eq('status', 'REVIEWED'),
      supabaseAdmin.from('badges').select('*'),
      supabaseAdmin.from('student_badges').select('badge_id').eq('student_id', studentId),
    ]);

    if (tErr) return res.status(500).json({ error: tErr.message });
    if (mErr) return res.status(500).json({ error: mErr.message });
    if (expErr) return res.status(500).json({ error: expErr.message });
    if (lorErr) return res.status(500).json({ error: lorErr.message });
    if (bErr || !allBadges) return res.status(500).json({ error: bErr?.message || 'Failed to fetch badges' });
    if (eErr) return res.status(500).json({ error: eErr.message });

    const volunteerHours = hoursFromExperiences(experiences || [], 'Volunteering');
    const shadowingHours = hoursFromExperiences(experiences || [], 'Shadowing');
    const lorCollected = profile.lor_external_service
      ? Number(profile.lor_external_collected) || 0
      : vaultLorCount || 0;
    const rawDat = Number(profile.dat_aa ?? profile.dat_score ?? 0) || 0;
    const earnedBadgeIds = new Set((earned || []).map((b) => b.badge_id));
    const newlyAwarded: any[] = [];

    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) continue;

      let qualifies = false;
      const threshold = Number(badge.benchmark_value);
      const type = badge.benchmark_type as BenchmarkType;

      switch (type) {
        case 'STRENGTH_SCORE':
          qualifies = (Number(profile.strength_score) || 0) >= threshold;
          break;
        case 'DAT':
          qualifies = datMeetsThreshold(rawDat, threshold);
          break;
        case 'PROGRESS':
          qualifies = (Number(profile.progress) || 0) >= threshold;
          break;
        case 'TASKS_COMPLETED':
          qualifies = (tasksCount || 0) >= threshold;
          break;
        case 'MEETINGS_ATTENDED':
          qualifies = (meetingsCount || 0) >= threshold;
          break;
        case 'GPA':
          qualifies = (Number(profile.gpa) || 0) >= threshold;
          break;
        case 'LOR_COLLECTED':
          qualifies = lorCollected >= threshold;
          break;
        case 'VOLUNTEER_HOURS':
          qualifies = volunteerHours >= threshold;
          break;
        case 'SHADOWING_HOURS':
          qualifies = shadowingHours >= threshold;
          break;
        default:
          break;
      }

      if (qualifies) {
        const { data: newAward, error: insertErr } = await supabaseAdmin
          .from('student_badges')
          .insert({
            student_id: studentId,
            badge_id: badge.id,
          })
          .select('*, badge:badges(*)')
          .single();

        if (!insertErr && newAward) {
          newlyAwarded.push(newAward);
        }
      }
    }

    const { data: totalEarned } = await supabaseAdmin
      .from('student_badges')
      .select('*, badge:badges(*)')
      .eq('student_id', studentId);

    res.json({
      newlyAwarded,
      totalEarned: totalEarned || [],
    });
  } catch (error: any) {
    console.error('Evaluate badges error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const badgesRouter = router;
