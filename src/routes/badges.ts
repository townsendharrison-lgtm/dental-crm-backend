import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

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
    if (updates.benchmarkType !== undefined) dbUpdates.benchmark_type = updates.benchmarkType;
    if (updates.benchmarkValue !== undefined) dbUpdates.benchmark_value = updates.benchmarkValue;

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
// Award qualified badges based on milestones reached (define award logic)
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

    // 1. Fetch student metrics profile
    const { data: profile, error: pErr } = await supabaseAdmin
      .from('student_profiles')
      .select('strength_score, dat_score, dat_aa, progress')
      .eq('id', studentId)
      .maybeSingle();

    if (pErr || !profile) {
      return res.status(404).json({ error: 'Student profile not found' });
    }

    // 2. Fetch completed tasks count
    const { count: tasksCount, error: tErr } = await supabaseAdmin
      .from('action_items')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', studentId)
      .eq('status', 'COMPLETED');

    if (tErr) return res.status(500).json({ error: tErr.message });

    // 3. Fetch completed meetings count
    const { count: meetingsCount, error: mErr } = await supabaseAdmin
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', studentId)
      .eq('completed', true);

    if (mErr) return res.status(500).json({ error: mErr.message });

    // 4. Fetch all badge definitions
    const { data: allBadges, error: bErr } = await supabaseAdmin
      .from('badges')
      .select('*');

    if (bErr || !allBadges) return res.status(500).json({ error: bErr?.message || 'Failed to fetch badges' });

    // 5. Fetch already earned badge IDs
    const { data: earned, error: eErr } = await supabaseAdmin
      .from('student_badges')
      .select('badge_id')
      .eq('student_id', studentId);

    if (eErr) return res.status(500).json({ error: eErr.message });
    const earnedBadgeIds = new Set((earned || []).map(b => b.badge_id));

    const newlyAwarded: any[] = [];

    // Evaluate award thresholds
    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) {
        continue; // Already earned
      }

      let qualifies = false;
      const threshold = Number(badge.benchmark_value);

      switch (badge.benchmark_type) {
        case 'STRENGTH_SCORE':
          qualifies = (profile.strength_score || 0) >= threshold;
          break;
        case 'DAT':
          const datValue = profile.dat_score || profile.dat_aa || 0;
          qualifies = datValue >= threshold;
          break;
        case 'PROGRESS':
          qualifies = (profile.progress || 0) >= threshold;
          break;
        case 'TASKS_COMPLETED':
          qualifies = (tasksCount || 0) >= threshold;
          break;
        case 'MEETINGS_ATTENDED':
          qualifies = (meetingsCount || 0) >= threshold;
          break;
        default:
          break;
      }

      if (qualifies) {
        // Insert earned badge achievement record
        const { data: newAward, error: insertErr } = await supabaseAdmin
          .from('student_badges')
          .insert({
            student_id: studentId,
            badge_id: badge.id
          })
          .select('*, badge:badges(*)')
          .single();

        if (!insertErr && newAward) {
          newlyAwarded.push(newAward);
        }
      }
    }

    // Fetch full earned badge list to return total
    const { data: totalEarned } = await supabaseAdmin
      .from('student_badges')
      .select('*, badge:badges(*)')
      .eq('student_id', studentId);

    res.json({
      newlyAwarded,
      totalEarned: totalEarned || []
    });
  } catch (error: any) {
    console.error('Evaluate badges error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const badgesRouter = router;
