import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { registerNotesDexterityRoutes } from './studentNotesDexterity.js';

const router = Router();

// Helper: Ensure a student has a profile record. If not, create one with default values.
async function getOrCreateStudentProfile(userId: string) {
  const { data: profile, error } = await supabaseAdmin
    .from('student_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    const { data: newProfile, error: insertError } = await supabaseAdmin
      .from('student_profiles')
      .insert({
        id: userId,
        readiness: 'YELLOW',
        progress: 0,
        strength_score: 0,
        status: 'Preparing',
        is_reapplicant: false,
        dat_verified: false,
        gpa_verified: false,
        lor_required: 0,
        lor_external_service: false,
      })
      .select()
      .single();

    if (insertError) {
      console.error(`Error initializing student profile for ${userId}:`, insertError);
      throw new Error(`Could not initialize student profile: ${insertError.message}`);
    }
    return newProfile;
  }
  return profile;
}

// GET /api/students - List students
// Admins and Mentor Managers see all. Mentors see only their assigned students.
router.get('/', authenticate, authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // 1. Get all users with STUDENT role
    const { data: studentUsers, error: usersError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('role', 'STUDENT');

    if (usersError) {
      return res.status(500).json({ error: usersError.message });
    }

    if (!studentUsers || studentUsers.length === 0) {
      return res.json({ students: [] });
    }

    // 2. Get student profiles
    let profilesQuery = supabaseAdmin.from('student_profiles').select('*');

    // Mentors only see their own assigned students
    if (userRole === 'MENTOR') {
      profilesQuery = profilesQuery.eq('mentor_id', userId);
    }

    const { data: profiles, error: profilesError } = await profilesQuery;

    if (profilesError) {
      return res.status(500).json({ error: profilesError.message });
    }

    const profilesMap = new Map<string, any>();
    if (profiles) {
      profiles.forEach(p => profilesMap.set(p.id, p));
    }

    // 3. Merge users and profiles, initializing missing profiles lazily
    const students = [];
    for (const user of studentUsers) {
      let profile = profilesMap.get(user.id);
      
      // If Mentor, skip students not assigned to them
      if (userRole === 'MENTOR' && !profile) {
        continue;
      }

      if (!profile && (userRole === 'ADMIN' || userRole === 'MENTOR_MANAGER')) {
        try {
          profile = await getOrCreateStudentProfile(user.id);
        } catch (err: any) {
          console.error(err);
          continue;
        }
      }

      students.push({
        ...user,
        profile: profile || null
      });
    }

    res.json({ students });
  } catch (error: any) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: error.message || 'Server error fetching students' });
  }
});

// GET /api/students/:id - Fetch single student profile
router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    // Authorization checks:
    // Students can only view their own profile.
    if (requesterRole === 'STUDENT' && requesterId !== id) {
      return res.status(403).json({ error: 'You can only access your own profile' });
    }

    // Get the base user
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', id)
      .eq('role', 'STUDENT')
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Ensure profile row exists
    let profile;
    try {
      profile = await getOrCreateStudentProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    // Mentors can only view if assigned
    if (requesterRole === 'MENTOR' && profile.mentor_id !== requesterId) {
      return res.status(403).json({ error: 'You are not assigned to this student' });
    }

    // Refresh auto strength score on read so it stays current
    const { recalculateStudentStrengthScore } = await import('../services/recalculateStrengthScore.js');
    const strengthScore = await recalculateStudentStrengthScore(id);
    profile = { ...profile, strength_score: strengthScore };

    const { listStudentSchoolCategories } = await import('../services/schoolCategories.js');
    const schoolCategories = await listStudentSchoolCategories(id);

    res.json({
      ...user,
      profile: {
        ...profile,
        school_categories: schoolCategories,
      },
      schoolCategories,
    });
  } catch (error: any) {
    console.error('Error fetching student profile:', error);
    res.status(500).json({ error: error.message || 'Server error fetching student' });
  }
});

// POST /api/students - Initialize/Create a student profile (Admin/Manager only)
router.post('/', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify the user exists and is a STUDENT
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('role', 'STUDENT')
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ error: 'Student user not found' });
    }

    const profile = await getOrCreateStudentProfile(userId);
    res.status(201).json({
      ...user,
      profile
    });
  } catch (error: any) {
    console.error('Error creating student profile:', error);
    res.status(500).json({ error: error.message || 'Server error creating student' });
  }
});

// PUT /api/students/:id - Update student profile
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;
    const updates = req.body;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    // Authorization checks:
    // Students can only update their own profile.
    if (requesterRole === 'STUDENT' && requesterId !== id) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }

    // Get existing profile to check assignments
    let existingProfile;
    try {
      existingProfile = await getOrCreateStudentProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    // Mentors can only update if assigned
    if (requesterRole === 'MENTOR' && existingProfile.mentor_id !== requesterId) {
      return res.status(403).json({ error: 'You are not assigned to this student' });
    }

    // Define permitted fields based on requester role
    const dbUpdates: any = { updated_at: new Date().toISOString() };

    // Common fields that students, mentors, and admins can update
    const commonFields = [
      'zip_code', 'gpa', 'dat_score', 'dat_aa', 'dat_ts', 'is_reapplicant',
      'application_cycle', 'state', 'country', 'ethnicity', 'gender', 'age',
      'undergrad_institution', 'undergrad_degree', 'undergrad_grad_year',
      'post_bac', 'masters', 'lor_required', 'lor_external_service', 'timezone',
      'school_categories',
    ];

    commonFields.forEach(field => {
      if (updates[field] !== undefined) {
        dbUpdates[field] = updates[field];
      }
    });

    // Accept camelCase schoolCategories from the frontend
    if (updates.schoolCategories !== undefined && updates.school_categories === undefined) {
      dbUpdates.school_categories = updates.schoolCategories;
    }

    // If GPA/DAT values change without an explicit re-verify, clear verification
    // so unverified edits cannot keep affecting strength score.
    const gpaChanging =
      updates.gpa !== undefined && Number(updates.gpa) !== Number(existingProfile.gpa);
    const datChanging =
      (updates.dat_score !== undefined && Number(updates.dat_score) !== Number(existingProfile.dat_score)) ||
      (updates.dat_aa !== undefined && Number(updates.dat_aa) !== Number(existingProfile.dat_aa)) ||
      (updates.dat_ts !== undefined && Number(updates.dat_ts) !== Number(existingProfile.dat_ts));

    if (gpaChanging && updates.gpa_verified !== true) {
      dbUpdates.gpa_verified = false;
    }
    if (datChanging && updates.dat_verified !== true) {
      dbUpdates.dat_verified = false;
    }

    // Student specific restrictions:
    // Students cannot change mentor assignment, progress, readiness, or DAT verification status
    // strength_score is ALWAYS formula-driven — never accept client writes
    if (requesterRole === 'ADMIN' || requesterRole === 'MENTOR_MANAGER' || requesterRole === 'MENTOR') {
      if (updates.readiness !== undefined) dbUpdates.readiness = updates.readiness;
      if (updates.progress !== undefined) dbUpdates.progress = updates.progress;
      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.dat_verified !== undefined) dbUpdates.dat_verified = updates.dat_verified;
      if (updates.gpa_verified !== undefined) dbUpdates.gpa_verified = updates.gpa_verified;
      if (updates.last_meeting_date !== undefined) dbUpdates.last_meeting_date = updates.last_meeting_date;
      if (updates.next_meeting_date !== undefined) dbUpdates.next_meeting_date = updates.next_meeting_date;
      if (updates.last_contact_date !== undefined) dbUpdates.last_contact_date = updates.last_contact_date;
      if (updates.missing_docs_count !== undefined) dbUpdates.missing_docs_count = updates.missing_docs_count;
      if (updates.open_action_items_count !== undefined) dbUpdates.open_action_items_count = updates.open_action_items_count;
      if (updates.avg_response_time !== undefined) dbUpdates.avg_response_time = updates.avg_response_time;
      if (updates.last_profile_reminder_at !== undefined) dbUpdates.last_profile_reminder_at = updates.last_profile_reminder_at;
    }

    // Only Admin & Mentor Manager can update mentor_id (reassignments are managed through specific assign/transfer endpoints)
    if ((requesterRole === 'ADMIN' || requesterRole === 'MENTOR_MANAGER') && updates.mentor_id !== undefined) {
      dbUpdates.mentor_id = updates.mentor_id;
    }

    // Update the student profile
    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('student_profiles')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating student profile:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    // Snapshot DAT history when scores change
    if (
      updates.dat_score !== undefined ||
      updates.dat_aa !== undefined ||
      updates.dat_ts !== undefined
    ) {
      const { recordDatHistoryIfChanged } = await import('../services/datHistory.js');
      await recordDatHistoryIfChanged(
        id,
        {
          dat_score: existingProfile.dat_score,
          dat_aa: existingProfile.dat_aa,
          dat_ts: existingProfile.dat_ts,
        },
        {
          dat_score: updatedProfile.dat_score,
          dat_aa: updatedProfile.dat_aa,
          dat_ts: updatedProfile.dat_ts,
        },
        requesterId,
      );
    }

    // Optional: Update name or avatar in user table if provided (Admins or Student self)
    if (requesterRole === 'ADMIN' || requesterId === id) {
      const userUpdates: any = {};
      if (updates.name !== undefined) userUpdates.name = updates.name;
      if (updates.avatar !== undefined) userUpdates.avatar = updates.avatar;

      if (Object.keys(userUpdates).length > 0) {
        await supabaseAdmin
          .from('users')
          .update(userUpdates)
          .eq('id', id);
      }
    }

    // Retrieve full updated student user details
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    const { recalculateStudentStrengthScore } = await import('../services/recalculateStrengthScore.js');
    const strengthScore = await recalculateStudentStrengthScore(id);

    res.json({
      ...user,
      profile: { ...updatedProfile, strength_score: strengthScore },
    });
  } catch (error: any) {
    console.error('Error updating student profile:', error);
    res.status(500).json({ error: error.message || 'Server error updating student' });
  }
});

// GET /api/students/:id/dat-history — DAT score snapshots over time
router.get('/:id/dat-history', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    if (requesterRole === 'STUDENT' && requesterId !== id) {
      return res.status(403).json({ error: 'You can only access your own profile' });
    }

    let profile;
    try {
      profile = await getOrCreateStudentProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    if (requesterRole === 'MENTOR' && profile.mentor_id !== requesterId) {
      return res.status(403).json({ error: 'You are not assigned to this student' });
    }

    const { listDatHistory } = await import('../services/datHistory.js');
    const history = await listDatHistory(id);
    res.json({ history });
  } catch (error: any) {
    console.error('Error fetching DAT history:', error);
    res.status(500).json({ error: error.message || 'Server error fetching DAT history' });
  }
});

// GET /api/students/:id/strength-history — strength score snapshots over time
router.get('/:id/strength-history', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    if (requesterRole === 'STUDENT' && requesterId !== id) {
      return res.status(403).json({ error: 'You can only access your own profile' });
    }

    let profile;
    try {
      profile = await getOrCreateStudentProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    if (requesterRole === 'MENTOR' && profile.mentor_id !== requesterId) {
      return res.status(403).json({ error: 'You are not assigned to this student' });
    }

    const { listStrengthHistory } = await import('../services/strengthHistory.js');
    const history = await listStrengthHistory(id);
    res.json({ history });
  } catch (error: any) {
    console.error('Error fetching strength history:', error);
    res.status(500).json({ error: error.message || 'Server error fetching strength history' });
  }
});

// GET /api/students/:id/strength-percentile — peer rank from live strength scores
router.get('/:id/strength-percentile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    if (requesterRole === 'STUDENT' && requesterId !== id) {
      return res.status(403).json({ error: 'You can only access your own profile' });
    }

    let profile;
    try {
      profile = await getOrCreateStudentProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    if (requesterRole === 'MENTOR' && profile.mentor_id !== requesterId) {
      return res.status(403).json({ error: 'You are not assigned to this student' });
    }

    const { recalculateStudentStrengthScore } = await import('../services/recalculateStrengthScore.js');
    const myScore = Math.round(Number(await recalculateStudentStrengthScore(id)) || 0);

    const { data: peers, error } = await supabaseAdmin
      .from('student_profiles')
      .select('id, strength_score');

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const scores = (peers || [])
      .map((p) => Math.round(Number(p.strength_score) || 0))
      .filter((s) => Number.isFinite(s));

    const cohortSize = scores.length;
    const below = scores.filter((s) => s < myScore).length;
    const equal = scores.filter((s) => s === myScore).length;
    // Classic percentile rank: share of cohort strictly below + half of ties
    const percentile =
      cohortSize > 1
        ? Math.round(((below + equal * 0.5) / cohortSize) * 100)
        : null;
    const aheadOf =
      cohortSize > 1 ? Math.round((below / Math.max(cohortSize - 1, 1)) * 100) : null;

    res.json({
      strengthScore: myScore,
      cohortSize,
      percentile,
      aheadOf,
    });
  } catch (error: any) {
    console.error('Error computing strength percentile:', error);
    res.status(500).json({ error: error.message || 'Server error computing percentile' });
  }
});

// Notes + manual dexterity (Records tab)
registerNotesDexterityRoutes(router);

// GET /api/students/:id/export.pdf — PDF profile export
router.get('/:id/export.pdf', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;
    if (!requesterId || !requesterRole) return res.status(401).json({ error: 'Unauthorized' });

    const {
      assertCanManageStudentShare,
      loadStudentPublicSnapshot,
    } = await import('../services/studentProfileShare.js');
    await assertCanManageStudentShare(requesterId, requesterRole, id);

    const snapshot = await loadStudentPublicSnapshot(id);
    const { buildStudentProfilePdf } = await import('../services/studentProfilePdf.js');
    const pdf = await buildStudentProfilePdf({
      student: snapshot.student,
      experiences: snapshot.experiences,
      documents: snapshot.documents,
      dexterity: snapshot.dexterity,
    });

    const safeName = (snapshot.student.name || 'student').replace(/[^\w\-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_profile.pdf"`);
    res.send(pdf);
  } catch (error: any) {
    const status = error?.status || 500;
    console.error('Error exporting student PDF:', error);
    res.status(status).json({ error: error.message || 'Server error exporting PDF' });
  }
});

// POST /api/students/:id/share — create or reuse an active public share link
router.post('/:id/share', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;
    if (!requesterId || !requesterRole) return res.status(401).json({ error: 'Unauthorized' });

    const {
      assertCanManageStudentShare,
      createShareToken,
      loadStudentPublicSnapshot,
    } = await import('../services/studentProfileShare.js');
    await assertCanManageStudentShare(requesterId, requesterRole, id);
    // Ensure student exists
    await loadStudentPublicSnapshot(id);

    const { data: existing } = await supabaseAdmin
      .from('student_profile_shares')
      .select('*')
      .eq('student_id', id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let share = existing;
    if (!share) {
      const token = createShareToken();
      const { data: created, error } = await supabaseAdmin
        .from('student_profile_shares')
        .insert({
          student_id: id,
          token,
          created_by: requesterId,
          is_active: true,
        })
        .select('*')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      share = created;
    }

    const frontendBase =
      process.env.FRONTEND_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      'http://localhost:3000';
    const shareUrl = `${frontendBase.replace(/\/$/, '')}/share/students/${share.token}`;

    res.json({
      token: share.token,
      shareUrl,
      createdAt: share.created_at,
    });
  } catch (error: any) {
    const status = error?.status || 500;
    console.error('Error creating student share link:', error);
    res.status(status).json({ error: error.message || 'Server error creating share link' });
  }
});

// DELETE /api/students/:id - Delete a student user (Admin only)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // 1. Delete from users table (cascades to student_profiles)
    const { error: userError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', id)
      .eq('role', 'STUDENT');

    if (userError) {
      return res.status(500).json({ error: userError.message });
    }

    // 2. Delete from Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);

    if (authError) {
      console.error(`Student user deleted in DB but auth deletion failed for ${id}:`, authError);
      // We don't fail the request since DB row is already gone
    }

    res.json({ message: 'Student deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting student:', error);
    res.status(500).json({ error: error.message || 'Server error deleting student' });
  }
});

// ─── School list categories ──────────────────────────────────────────

async function assertCanAccessStudentCategories(req: AuthRequest, studentId: string) {
  const requesterId = req.user!.id;
  const role = req.user!.role;
  if (role === 'STUDENT') {
    if (requesterId !== studentId) return { ok: false as const, status: 403, error: 'Access denied' };
    return { ok: true as const };
  }
  if (role === 'ADMIN' || role === 'MENTOR_MANAGER') return { ok: true as const };
  if (role === 'MENTOR') {
    const { data: profile } = await supabaseAdmin
      .from('student_profiles')
      .select('mentor_id')
      .eq('id', studentId)
      .maybeSingle();
    if (profile?.mentor_id !== requesterId) {
      return { ok: false as const, status: 403, error: 'You are not assigned to this student' };
    }
    return { ok: true as const };
  }
  return { ok: false as const, status: 403, error: 'Access denied' };
}

// GET /api/students/:id/school-categories
router.get('/:id/school-categories', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const access = await assertCanAccessStudentCategories(req, id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const { listStudentSchoolCategories } = await import('../services/schoolCategories.js');
    const categories = await listStudentSchoolCategories(id);
    res.json({ categories });
  } catch (error: any) {
    console.error('List school categories error:', error);
    res.status(500).json({ error: error.message || 'Failed to load school categories' });
  }
});

// PUT /api/students/:id/school-categories
router.put('/:id/school-categories', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const access = await assertCanAccessStudentCategories(req, id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const categories = req.body?.categories ?? req.body?.schoolCategories ?? req.body;
    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories array is required' });
    }

    const { replaceStudentSchoolCategories } = await import('../services/schoolCategories.js');
    const saved = await replaceStudentSchoolCategories(id, categories);
    res.json({ categories: saved });
  } catch (error: any) {
    console.error('Save school categories error:', error);
    res.status(500).json({ error: error.message || 'Failed to save school categories' });
  }
});

export const studentsRouter = router;
