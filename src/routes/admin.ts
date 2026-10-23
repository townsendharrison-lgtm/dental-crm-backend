import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { VALID_ROLES } from '../types/index.js';
import type { UserRole } from '../types/index.js';
import { buildPlatformAnalytics } from '../services/platformAnalytics.js';
import { sendInvitationEmail } from '../services/inviteEmailService.js';
import {
  buildAppInviteUrl,
  formatInviteLifetime,
  inviteExpiresAt,
} from '../services/inviteLink.js';

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
      supabaseAdmin.from('experiences').select('student_id, category, prior_hours, sessions:experience_sessions(duration)'),
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

    const realStudentUsers = (studentUsers || []).filter(
      (u: any) => !String(u.email || '').toLowerCase().endsWith('@school-selection.local'),
    );

    const analytics = buildPlatformAnalytics({
      studentUsers: realStudentUsers,
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

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const url = `${process.env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  });
  const target = email.toLowerCase();
  if (response.ok) {
    const body = (await response.json()) as { users?: { id: string; email?: string }[] };
    const match = body.users?.find((user) => user.email?.toLowerCase() === target);
    if (match) return match.id;
  }

  for (let page = 1; page <= 5; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const match = data.users.find((user) => user.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/**
 * Create the auth account once. The emailed link is our own token, not Supabase's
 * one-time verify URL, so opening the email cannot mark it expired.
 */
async function ensureInvitedAuthUser(
  email: string,
  role: string,
  inviterName: string,
): Promise<{ authUserId: string } | { error: string }> {
  const user_metadata = { role, name: '', invited_by_name: inviterName };
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password: randomBytes(32).toString('base64url'),
    email_confirm: true,
    user_metadata,
  });
  if (created.data.user?.id) return { authUserId: created.data.user.id };

  const message = created.error?.message || '';
  if (!/already|registered|exists/i.test(message)) {
    return { error: message || 'Could not create the account' };
  }

  const authUserId = await findAuthUserIdByEmail(email);
  if (!authUserId) return { error: message || 'Could not create the account' };
  await supabaseAdmin.auth.admin.updateUserById(authUserId, {
    email_confirm: true,
    user_metadata,
  });
  return { authUserId };
}

function newInviteToken(authUserId: string): string {
  return `${authUserId}.${randomBytes(32).toString('hex')}`;
}

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

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const inviterName = inviter?.name || 'Admin';

    const issued = await ensureInvitedAuthUser(email, role, inviterName);
    if ('error' in issued) {
      return res.status(400).json({ error: issued.error });
    }

    const invitationToken = newInviteToken(issued.authUserId);
    const invitationLink = buildAppInviteUrl(frontendUrl, invitationToken);
    const expiresInLabel = formatInviteLifetime();

    const emailResult = await sendInvitationEmail({
      email,
      role,
      inviterName,
      actionLink: invitationLink,
      expiresInLabel,
    });
    const emailSent = emailResult.success;
    if (!emailResult.success) {
      console.warn(`Resend email delivery skipped/failed (${emailResult.error}). Link was not rotated.`);
    }

    // Track the invitation for the same lifetime as Supabase's email OTP expiration.
    const expiresAt = inviteExpiresAt();

    const { data: invitation, error: trackError } = await supabaseAdmin
      .from('invitations')
      .insert({
        id: uuidv4(),
        email,
        role,
        token: invitationToken,
        invited_by: req.user!.id,
        invited_by_name: inviterName,
        status: 'PENDING',
        created_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (trackError) {
      console.error('Failed to track invitation:', trackError.message);
    }

    res.json({
      message: emailSent
        ? 'Invitation email sent successfully'
        : 'Invitation link generated (email delivery pending)',
      invitation: invitation || { email, role, status: 'PENDING' },
      invitationLink, // Admin can copy this exact valid link
      emailSent,
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

    // Get the invitation record (allow resending if PENDING or EXPIRED)
    const { data: invitation, error: fetchError } = await supabaseAdmin
      .from('invitations')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !invitation || invitation.status === 'ACCEPTED') {
      return res.status(400).json({
        error: invitation?.status === 'ACCEPTED'
          ? 'User has already accepted this invitation'
          : 'Invitation not found',
      });
    }

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const inviterName = invitation.invited_by_name || 'Admin';

    const issued = await ensureInvitedAuthUser(invitation.email, invitation.role, inviterName);
    if ('error' in issued) {
      return res.status(400).json({ error: issued.error });
    }

    const invitationToken = newInviteToken(issued.authUserId);
    const newLink = buildAppInviteUrl(frontendUrl, invitationToken);
    const expiresInLabel = formatInviteLifetime();
    const emailResult = await sendInvitationEmail({
      email: invitation.email,
      role: invitation.role,
      inviterName,
      actionLink: newLink,
      expiresInLabel,
    });
    const emailSent = emailResult.success;
    if (!emailResult.success) {
      console.warn(`Resend email failed (${emailResult.error}). Link was not rotated.`);
    }

    const expiresAt = inviteExpiresAt();
    await supabaseAdmin
      .from('invitations')
      .update({
        token: invitationToken,
        status: 'PENDING',
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      })
      .eq('id', id);

    res.json({
      message: 'Invitation resent successfully',
      invitationLink: newLink,
      emailSent,
    });
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

    // Hide legacy school-selection shell accounts from User Management
    const filtered = (users || []).filter(
      (u) => !String(u.email || '').toLowerCase().endsWith('@school-selection.local'),
    );

    res.json(filtered);
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

    const students = (candidates || []).filter(
      (u) =>
        u.id !== req.user!.id &&
        !String(u.email || '').toLowerCase().endsWith('@school-selection.local'),
    );
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
