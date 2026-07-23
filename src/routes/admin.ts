import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { VALID_ROLES } from '../types/index.js';
import type { UserRole } from '../types/index.js';
import { buildPlatformAnalytics } from '../services/platformAnalytics.js';

const router = Router();

// Authenticate all admin routes; most require ADMIN, analytics also allows MENTOR_MANAGER
router.use(authenticate);

// ─── GET /api/admin/analytics ────────────────────────────────────────
// Platform-wide Global Data aggregations (Admin + Mentor Manager)
router.get('/analytics', authorize('ADMIN', 'MENTOR_MANAGER'), async (_req: AuthRequest, res: Response) => {
  try {
    const [
      { data: studentUsers, error: studentsError },
      { data: profiles, error: profilesError },
      { data: mentorUsers, error: mentorsError },
      { data: mentorProfiles, error: mentorProfilesError },
      { data: applications, error: appsError },
      { data: experiences, error: expsError },
    ] = await Promise.all([
      supabaseAdmin.from('users').select('id, name, avatar, created_at').eq('role', 'STUDENT'),
      supabaseAdmin.from('student_profiles').select('*'),
      supabaseAdmin.from('users').select('id, name, avatar').eq('role', 'MENTOR'),
      supabaseAdmin.from('mentor_profiles').select('*'),
      supabaseAdmin.from('applications').select('*, school:schools(id, name)'),
      supabaseAdmin.from('experiences').select('student_id, category, sessions:experience_sessions(duration)'),
    ]);

    if (studentsError) return res.status(500).json({ error: studentsError.message });
    if (profilesError) return res.status(500).json({ error: profilesError.message });
    if (mentorsError) return res.status(500).json({ error: mentorsError.message });
    if (mentorProfilesError) return res.status(500).json({ error: mentorProfilesError.message });
    if (appsError) return res.status(500).json({ error: appsError.message });
    if (expsError) return res.status(500).json({ error: expsError.message });

    const profilesMap: Record<string, any> = {};
    (profiles || []).forEach((p: any) => {
      profilesMap[p.id] = p;
    });

    const mentorProfilesMap: Record<string, any> = {};
    (mentorProfiles || []).forEach((p: any) => {
      mentorProfilesMap[p.id] = p;
    });

    const analytics = buildPlatformAnalytics({
      studentUsers: studentUsers || [],
      profiles: profilesMap,
      mentorUsers: mentorUsers || [],
      mentorProfiles: mentorProfilesMap,
      applications: applications || [],
      experiences: experiences || [],
    });

    res.json(analytics);
  } catch (error: any) {
    console.error('Platform analytics error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Remaining admin routes are ADMIN-only
router.use(authorize('ADMIN'));

// Invite user using Supabase built-in invite
router.post('/invite', async (req: AuthRequest, res: Response) => {
  try {
    const { email, role } = req.body;

    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if user already exists in our users table
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Check if there's already a pending invitation in our tracking table
    const { data: existingInvitation } = await supabaseAdmin
      .from('invitations')
      .select('id')
      .eq('email', email)
      .eq('status', 'PENDING')
      .single();

    if (existingInvitation) {
      return res.status(400).json({ error: 'Pending invitation already exists for this email' });
    }

    // Get inviter name
    const { data: inviter } = await supabaseAdmin
      .from('users')
      .select('name')
      .eq('id', req.user!.id)
      .single();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // 1. Generate a shareable link FIRST (admin can copy this)
    // We do this before inviteUserByEmail so the email token (generated second) stays valid.
    let invitationLink = '';
    const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        data: {
          role,
          name: '',
          invited_by_name: inviter?.name || 'Admin',
        },
        redirectTo: `${frontendUrl}/#/complete-invitation`,
      },
    });

    if (linkData?.properties?.action_link) {
      invitationLink = linkData.properties.action_link;
    }

    // 2. Send the invite email LAST — its token will be the valid one
    const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: {
        role,
        name: '',
        invited_by_name: inviter?.name || 'Admin',
      },
      redirectTo: `${frontendUrl}/#/complete-invitation`,
    });

    if (inviteError) {
      return res.status(400).json({ error: inviteError.message });
    }

    // Track the invitation in our table for admin visibility
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const { data: invitation, error: trackError } = await supabaseAdmin
      .from('invitations')
      .insert({
        id: uuidv4(),
        email,
        role,
        token: inviteData.user?.id || uuidv4(), // Store auth user ID as reference
        invited_by: req.user!.id,
        invited_by_name: inviter?.name || 'Admin',
        status: 'PENDING',
        created_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString()
      })
      .select()
      .single();

    if (trackError) {
      console.error('Failed to track invitation:', trackError.message);
      // Don't fail — the Supabase invite was already sent
    }

    res.json({
      message: 'Invitation email sent successfully via Supabase',
      invitation: invitation || { email, role, status: 'PENDING' },
      invitationLink, // Admin can also copy this link
      emailSent: true,
    });
  } catch (error) {
    console.error('Create invitation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resend invitation email
router.post('/invitations/:id/resend', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Get the invitation record
    const { data: invitation, error: fetchError } = await supabaseAdmin
      .from('invitations')
      .select('*')
      .eq('id', id)
      .eq('status', 'PENDING')
      .single();

    if (fetchError || !invitation) {
      return res.status(404).json({ error: 'Invitation not found or already accepted' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // Re-invite via Supabase (this resends the email)
    const { error: reinviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(invitation.email, {
      data: {
        role: invitation.role,
        name: '',
        invited_by_name: invitation.invited_by_name,
      },
      redirectTo: `${frontendUrl}/#/complete-invitation`,
    });

    if (reinviteError) {
      return res.status(400).json({ error: reinviteError.message });
    }

    res.json({ message: 'Invitation resent successfully' });
  } catch (error) {
    console.error('Resend invitation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all invitations
router.get('/invitations', async (req: AuthRequest, res: Response) => {
  try {
    const { data: invitations, error } = await supabaseAdmin
      .from('invitations')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(invitations);
  } catch (error) {
    console.error('Get invitations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete invitation
router.delete('/invitations/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('invitations')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Invitation deleted successfully' });
  } catch (error) {
    console.error('Delete invitation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user role
router.put('/users/:id/role', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Update role in users table
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (userError) {
      return res.status(400).json({ error: userError.message });
    }

    // Update role in Supabase Auth user_metadata
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(id, {
      user_metadata: { role }
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    res.json(user);
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user details (e.g. goals)
router.put('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { weeklyLeadGoal, monthlyLeadGoal, name, avatar } = req.body;

    const updates: any = { updated_at: new Date().toISOString() };
    if (weeklyLeadGoal !== undefined) updates.weekly_lead_goal = weeklyLeadGoal;
    if (monthlyLeadGoal !== undefined) updates.monthly_lead_goal = monthlyLeadGoal;
    if (name !== undefined) updates.name = name;
    if (avatar !== undefined) updates.avatar = avatar;

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(user);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user
router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Prevent deleting own account
    if (id === req.user!.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Delete from users table
    const { error: userError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', id);

    if (userError) {
      return res.status(400).json({ error: userError.message });
    }

    // Delete from Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk delete student accounts older than N years
router.post('/users/bulk-delete-old-students', async (req: AuthRequest, res: Response) => {
  try {
    const years = Number(req.body?.olderThanYears);
    if (!Number.isFinite(years) || years < 1 || years > 50) {
      return res.status(400).json({ error: 'olderThanYears must be between 1 and 50' });
    }

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutoffIso = cutoff.toISOString();

    const { data: candidates, error: listError } = await supabaseAdmin
      .from('users')
      .select('id, email, name, created_at')
      .eq('role', 'STUDENT')
      .lt('created_at', cutoffIso);

    if (listError) {
      return res.status(400).json({ error: listError.message });
    }

    const students = (candidates || []).filter((u) => u.id !== req.user!.id);
    let deleted = 0;
    const failed: { id: string; error: string }[] = [];

    for (const student of students) {
      try {
        const { error: userError } = await supabaseAdmin
          .from('users')
          .delete()
          .eq('id', student.id);

        if (userError) {
          failed.push({ id: student.id, error: userError.message });
          continue;
        }

        const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(student.id);
        if (authError) {
          failed.push({ id: student.id, error: authError.message });
          continue;
        }

        deleted += 1;
      } catch (err: any) {
        failed.push({ id: student.id, error: err?.message || 'Unknown error' });
      }
    }

    res.json({
      message: `Deleted ${deleted} student${deleted === 1 ? '' : 's'} older than ${years} year${years === 1 ? '' : 's'}`,
      deleted,
      failed,
      cutoff: cutoffIso,
      matched: students.length,
    });
  } catch (error) {
    console.error('Bulk delete old students error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as adminRouter };
