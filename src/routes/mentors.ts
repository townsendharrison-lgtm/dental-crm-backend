import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Helper: Ensure a mentor has a profile record.
async function getOrCreateMentorProfile(userId: string) {
  const { data: profile, error } = await supabaseAdmin
    .from('mentor_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    const { data: newProfile, error: insertError } = await supabaseAdmin
      .from('mentor_profiles')
      .insert({
        id: userId,
        avg_response_time: '4h',
        avg_response_time_value: 4.0,
        compliance_score: 100,
        manager_score: 100,
        default_availability: [],
      })
      .select()
      .single();

    if (insertError) {
      console.error(`Error initializing mentor profile for ${userId}:`, insertError);
      throw new Error(`Could not initialize mentor profile: ${insertError.message}`);
    }
    return newProfile;
  }
  return profile;
}

// GET /api/mentors - List all mentors
// Access: Admins and Mentor Managers
router.get('/', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    // 1. Fetch all users with MENTOR role
    const { data: mentorUsers, error: usersError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('role', 'MENTOR');

    if (usersError) {
      return res.status(500).json({ error: usersError.message });
    }

    if (!mentorUsers || mentorUsers.length === 0) {
      return res.json({ mentors: [] });
    }

    // 2. Fetch all mentor profiles
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('mentor_profiles')
      .select('*');

    if (profilesError) {
      return res.status(500).json({ error: profilesError.message });
    }

    const profilesMap = new Map<string, any>();
    if (profiles) {
      profiles.forEach(p => profilesMap.set(p.id, p));
    }

    // 3. Fetch all assigned students to group by mentor_id
    const { data: students, error: studentsError } = await supabaseAdmin
      .from('student_profiles')
      .select('id, mentor_id')
      .not('mentor_id', 'is', null);

    if (studentsError) {
      return res.status(500).json({ error: studentsError.message });
    }

    const mentorStudentsMap = new Map<string, string[]>();
    if (students) {
      students.forEach(s => {
        if (s.mentor_id) {
          const list = mentorStudentsMap.get(s.mentor_id) || [];
          list.push(s.id);
          mentorStudentsMap.set(s.mentor_id, list);
        }
      });
    }

    // 4. Merge data
    const mentors = [];
    for (const user of mentorUsers) {
      let profile = profilesMap.get(user.id);
      if (!profile) {
        try {
          profile = await getOrCreateMentorProfile(user.id);
        } catch (err: any) {
          console.error(err);
          continue;
        }
      }

      mentors.push({
        ...user,
        profile,
        studentIds: mentorStudentsMap.get(user.id) || []
      });
    }

    res.json({ mentors });
  } catch (error: any) {
    console.error('Error fetching mentors:', error);
    res.status(500).json({ error: error.message || 'Server error fetching mentors' });
  }
});

// GET /api/mentors/assignments - List student↔mentor assignment history
// Access: Admins and Mentor Managers
// IMPORTANT: must be registered before /:id so "assignments" is not treated as an id
router.get('/assignments', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (_req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('student_assignments')
      .select('*')
      .order('assigned_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ assignments: data || [] });
  } catch (error: any) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: error.message || 'Server error fetching assignments' });
  }
});

// GET /api/mentors/:id - Fetch single mentor
router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    // Mentors can only view their own detailed profile unless Admin/Manager
    if (requesterRole === 'MENTOR' && requesterId !== id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch user
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', id)
      .eq('role', 'MENTOR')
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ error: 'Mentor not found' });
    }

    // Ensure profile row exists
    let profile;
    try {
      profile = await getOrCreateMentorProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    // Fetch assigned student IDs
    const { data: students } = await supabaseAdmin
      .from('student_profiles')
      .select('id')
      .eq('mentor_id', id);

    const studentIds = students ? students.map(s => s.id) : [];

    res.json({
      ...user,
      profile,
      studentIds
    });
  } catch (error: any) {
    console.error('Error fetching mentor:', error);
    res.status(500).json({ error: error.message || 'Server error fetching mentor' });
  }
});

// PUT /api/mentors/:id - Update mentor profile
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;
    const updates = req.body;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    // Mentors can only update their own profile
    if (requesterRole === 'MENTOR' && requesterId !== id) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }

    // Admins, Managers, and Mentors themselves can update
    if (requesterRole !== 'ADMIN' && requesterRole !== 'MENTOR_MANAGER' && requesterId !== id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Ensure profile exists
    try {
      await getOrCreateMentorProfile(id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }

    const profileUpdates: any = { updated_at: new Date().toISOString() };

    // Fields anyone (including Mentor self) can update
    const commonFields = ['phone', 'school', 'graduation_year', 'default_availability', 'notes'];
    commonFields.forEach(field => {
      if (updates[field] !== undefined) {
        profileUpdates[field] = updates[field];
      }
    });

    // Fields only Admin/Manager can update
    if (requesterRole === 'ADMIN' || requesterRole === 'MENTOR_MANAGER') {
      if (updates.avg_response_time !== undefined) profileUpdates.avg_response_time = updates.avg_response_time;
      if (updates.avg_response_time_value !== undefined) profileUpdates.avg_response_time_value = updates.avg_response_time_value;
      if (updates.compliance_score !== undefined) profileUpdates.compliance_score = updates.compliance_score;
      if (updates.manager_score !== undefined) profileUpdates.manager_score = updates.manager_score;
    }

    // Update profile
    const { data: updatedProfile, error: profileError } = await supabaseAdmin
      .from('mentor_profiles')
      .update(profileUpdates)
      .eq('id', id)
      .select()
      .single();

    if (profileError) {
      return res.status(500).json({ error: profileError.message });
    }

    // Optional: Update name or avatar in user table if provided (Admins or Mentor self)
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

    // Retrieve full updated details
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    res.json({
      ...user,
      profile: updatedProfile
    });
  } catch (error: any) {
    console.error('Error updating mentor:', error);
    res.status(500).json({ error: error.message || 'Server error updating mentor' });
  }
});

// DELETE /api/mentors/:id - Delete a mentor user (Admin only)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // 1. Delete from users table (cascades to mentor_profiles, sets student_profiles.mentor_id = null)
    const { error: userError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', id)
      .eq('role', 'MENTOR');

    if (userError) {
      return res.status(500).json({ error: userError.message });
    }

    // 2. Delete from Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);

    if (authError) {
      console.error(`Mentor user deleted in DB but auth deletion failed for ${id}:`, authError);
    }

    res.json({ message: 'Mentor deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting mentor:', error);
    res.status(500).json({ error: error.message || 'Server error deleting mentor' });
  }
});

// POST /api/mentors/assign - Assign student to mentor
// Access: Admins and Mentor Managers
router.post('/assign', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { studentId, mentorId, welcomeMessage } = req.body;

    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // Verify student user exists
    const { data: studentUser, error: sErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', studentId)
      .eq('role', 'STUDENT')
      .maybeSingle();

    if (sErr || !studentUser) {
      return res.status(404).json({ error: 'Student user not found' });
    }

    // Verify mentor user exists if mentorId is provided (unassigning is done by setting mentorId to null)
    if (mentorId) {
      const { data: mentorUser, error: mErr } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('id', mentorId)
        .eq('role', 'MENTOR')
        .maybeSingle();

      if (mErr || !mentorUser) {
        return res.status(404).json({ error: 'Mentor user not found' });
      }
    }

    // Update student profile with new mentor_id
    const { error: updateErr } = await supabaseAdmin
      .from('student_profiles')
      .update({ mentor_id: mentorId || null, updated_at: new Date().toISOString() })
      .eq('id', studentId);

    if (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }

    // Log the assignment event
    const { error: logErr } = await supabaseAdmin
      .from('student_assignments')
      .insert({
        student_id: studentId,
        mentor_id: mentorId || null,
        status: 'ACCEPTED', // Admin assignment is automatically accepted
        assigned_at: new Date().toISOString(),
        accepted_at: mentorId ? new Date().toISOString() : null,
        welcome_message: welcomeMessage || null
      });

    if (logErr) {
      console.error('Failed to log student assignment history:', logErr);
    }

    res.json({ message: 'Mentor assigned successfully', studentId, mentorId });
  } catch (error: any) {
    console.error('Error assigning mentor:', error);
    res.status(500).json({ error: error.message || 'Server error assigning mentor' });
  }
});

// POST /api/mentors/transfer - Transfer student to a different mentor
// Access: Admins and Mentor Managers
router.post('/transfer', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { studentId, newMentorId, note } = req.body;

    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // 1. Verify student exists
    const { data: studentProfile, error: spErr } = await supabaseAdmin
      .from('student_profiles')
      .select('mentor_id')
      .eq('id', studentId)
      .maybeSingle();

    if (spErr || !studentProfile) {
      return res.status(404).json({ error: 'Student profile not found' });
    }

    const oldMentorId = studentProfile.mentor_id;

    // 2. Verify new mentor user exists if provided
    if (newMentorId) {
      const { data: mentorUser, error: mErr } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('id', newMentorId)
        .eq('role', 'MENTOR')
        .maybeSingle();

      if (mErr || !mentorUser) {
        return res.status(404).json({ error: 'New mentor user not found' });
      }
    }

    // 3. Mark old active assignments as TRANSFERRED
    if (oldMentorId) {
      await supabaseAdmin
        .from('student_assignments')
        .update({
          status: 'TRANSFERRED',
          transferred_at: new Date().toISOString()
        })
        .eq('student_id', studentId)
        .eq('mentor_id', oldMentorId)
        .eq('status', 'ACCEPTED');
    }

    // 4. Update student profile
    const { error: updateErr } = await supabaseAdmin
      .from('student_profiles')
      .update({ mentor_id: newMentorId || null, updated_at: new Date().toISOString() })
      .eq('id', studentId);

    if (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }

    // 5. Create new assignment row
    const { error: logErr } = await supabaseAdmin
      .from('student_assignments')
      .insert({
        student_id: studentId,
        mentor_id: newMentorId || null,
        status: 'ACCEPTED',
        assigned_at: new Date().toISOString(),
        accepted_at: newMentorId ? new Date().toISOString() : null,
        welcome_message: note || `Transferred from previous mentor.`
      });

    if (logErr) {
      console.error('Failed to log student transfer history:', logErr);
    }

    res.json({
      message: 'Student transferred successfully',
      studentId,
      oldMentorId,
      newMentorId
    });
  } catch (error: any) {
    console.error('Error transferring student:', error);
    res.status(500).json({ error: error.message || 'Server error transferring student' });
  }
});

// GET /api/mentors/:id/students - Fetch assigned students for a mentor
router.get('/:id/students', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id;
    const requesterRole = req.user?.role;

    if (!requesterId) return res.status(401).json({ error: 'Unauthorized' });

    // Mentors can only view their own assigned students
    if (requesterRole === 'MENTOR' && requesterId !== id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // 1. Fetch assigned students profiles
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from('student_profiles')
      .select('*')
      .eq('mentor_id', id);

    if (pErr) {
      return res.status(500).json({ error: pErr.message });
    }

    if (!profiles || profiles.length === 0) {
      return res.json({ students: [] });
    }

    const studentIds = profiles.map(p => p.id);

    // 2. Fetch user information for these students
    const { data: users, error: uErr } = await supabaseAdmin
      .from('users')
      .select('*')
      .in('id', studentIds);

    if (uErr) {
      return res.status(500).json({ error: uErr.message });
    }

    const profilesMap = new Map<string, any>();
    profiles.forEach(p => profilesMap.set(p.id, p));

    const students = (users || []).map(u => ({
      ...u,
      profile: profilesMap.get(u.id) || null
    }));

    res.json({ students });
  } catch (error: any) {
    console.error('Error fetching mentor students:', error);
    res.status(500).json({ error: error.message || 'Server error fetching mentor students' });
  }
});

export const mentorsRouter = router;
