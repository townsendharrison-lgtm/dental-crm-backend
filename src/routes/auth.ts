import { Router, Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { SignInRequest, ResetPasswordRequest } from '../types/index.js';

const router = Router();

const INVITE_INVALID = 'This invitation link is no longer valid. Ask your administrator to resend it.';

async function authUserFromInvitationToken(token: string) {
  const { data: invitation, error } = await supabaseAdmin
    .from('invitations')
    .select('email, status, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error || !invitation || invitation.status !== 'PENDING') return { error: INVITE_INVALID };
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    return { error: 'This invitation link has expired. Ask your administrator to resend it.' };
  }

  const authUserId = token.split('.')[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authUserId)) {
    return { error: INVITE_INVALID };
  }

  const { data, error: userError } = await supabaseAdmin.auth.admin.getUserById(authUserId);
  if (userError || !data.user || data.user.email?.toLowerCase() !== String(invitation.email).toLowerCase()) {
    return { error: INVITE_INVALID };
  }
  return { user: data.user };
}

// Preview an invitation without using it up. Opening the page must not expire the link.
router.get('/invitation', async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token || '');
    const loaded = await authUserFromInvitationToken(token);
    if ('error' in loaded) return res.status(400).json({ error: loaded.error });

    const metadata = loaded.user.user_metadata || {};
    res.json({
      email: loaded.user.email,
      role: metadata.role || 'STUDENT',
      invitedByName: metadata.invited_by_name || '',
    });
  } catch (error) {
    console.error('Invitation preview error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete invitation — name and password form. Accepts our invitation token,
// or a Supabase access token from an older redirect link.
router.post('/complete-invitation', async (req: Request, res: Response) => {
  try {
    const { accessToken, invitationToken, name, password } = req.body;

    if ((!accessToken && !invitationToken) || !name || !password) {
      return res.status(400).json({ error: 'Name and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    let authUser;
    if (invitationToken) {
      const loaded = await authUserFromInvitationToken(String(invitationToken));
      if ('error' in loaded) return res.status(400).json({ error: loaded.error });
      authUser = loaded.user;
    } else {
      const { data, error: verifyError } = await supabase.auth.getUser(accessToken);
      authUser = data.user;
      if (verifyError || !authUser) {
        return res.status(400).json({ error: 'Invalid or expired invitation link. Please ask admin to resend the invite.' });
      }
    }

    // Get the role from user_metadata (set during invite)
    const role = authUser.user_metadata?.role || 'STUDENT';

    // Update the user's password and name in Supabase Auth
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      password,
      email_confirm: true,
      user_metadata: {
        ...authUser.user_metadata,
        name,
      },
    });

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    // Create user profile in our custom users table (if not already there)
    const { data: existingProfile } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', authUser.id)
      .single();

    if (!existingProfile) {
      const { error: profileError } = await supabaseAdmin
        .from('users')
        .insert({
          id: authUser.id,
          email: authUser.email!,
          name,
          role,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (profileError) {
        console.error('Failed to create user profile:', profileError.message);
        return res.status(500).json({ error: 'Failed to create user profile' });
      }
    } else {
      // Update existing profile with the name
      await supabaseAdmin
        .from('users')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', authUser.id);
    }

    // Update invitation status to ACCEPTED
    await supabaseAdmin
      .from('invitations')
      .update({ status: 'ACCEPTED' })
      .eq('email', authUser.email!)
      .eq('status', 'PENDING');

    // Trigger welcome message automation templates binding
    try {
      const { data: config } = await supabaseAdmin
        .from('admin_settings')
        .select('welcome_template_student, welcome_template_mentor')
        .eq('id', 1)
        .maybeSingle();

      const { data: adminUser } = await supabaseAdmin
        .from('users')
        .select('id, name')
        .eq('role', 'ADMIN')
        .limit(1)
        .maybeSingle();

      if (adminUser) {
        let welcomeText = '';
        if (role === 'STUDENT' && config?.welcome_template_student) {
          welcomeText = config.welcome_template_student
            .replace(/\{\{\s*student_name\s*\}\}/g, name)
            .replace(/\{\{\s*name\s*\}\}/g, name);
        } else if (role === 'MENTOR' && config?.welcome_template_mentor) {
          welcomeText = config.welcome_template_mentor
            .replace(/\{\{\s*mentor_name\s*\}\}/g, name)
            .replace(/\{\{\s*name\s*\}\}/g, name);
        }

        if (welcomeText) {
          // Create conversation between new user and first admin
          const { data: newConv, error: cErr } = await supabaseAdmin
            .from('conversations')
            .insert({
              participant_ids: [authUser.id, adminUser.id],
              is_group: false
            })
            .select()
            .single();

          if (!cErr && newConv) {
            // Post message
            await supabaseAdmin.from('messages').insert({
              conversation_id: newConv.id,
              sender_id: adminUser.id,
              text: welcomeText,
              read_by: [adminUser.id]
            });

            // Create notification for the new user (store full welcome text)
            await supabaseAdmin.from('notifications').insert({
              user_id: authUser.id,
              title: `👋 Welcome to Dental CRM`,
              message: welcomeText,
              type: 'INFO',
              category: 'NEW_MESSAGE',
              related_id: newConv.id,
              is_read: false,
              created_by: adminUser.id
            });
          }
        }
      }
    } catch (welcomeErr) {
      console.error('Welcome automation message dispatch error:', welcomeErr);
    }

    // Sign in the user to get a session
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: authUser.email!,
      password,
    });

    if (signInError || !signInData.session) {
      // Account created successfully but auto-signin failed — user can sign in manually
      return res.status(201).json({
        message: 'Account setup complete! Please sign in.',
        autoSignIn: false,
      });
    }

    res.status(201).json({
      message: 'Account setup complete!',
      autoSignIn: true,
      token: signInData.session.access_token,
      refreshToken: signInData.session.refresh_token,
      user: {
        id: authUser.id,
        email: authUser.email,
        name,
        role,
      },
    });
  } catch (error) {
    console.error('Complete invitation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign in
router.post('/signin', async (req: Request, res: Response) => {
  try {
    const { email, password }: SignInRequest = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    const user = data.user;
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    const role = profile?.role || user.user_metadata?.role || 'STUDENT';

    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.user_metadata?.name || '',
        role,
        avatar: profile?.avatar,
        timezone: profile?.timezone || undefined,
        onboardingCompletedAt: profile?.onboarding_completed_at || null,
        onboardingStepIds: Array.isArray(profile?.onboarding_step_ids) ? profile.onboarding_step_ids : [],
      }
    });
  } catch (error) {
    console.error('Signin error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign out
router.post('/signout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.substring(7);

    if (token) {
      await supabase.auth.signOut();
    }

    res.json({ message: 'Signed out successfully' });
  } catch (error) {
    console.error('Signout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password request
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email }: ResetPasswordRequest = req.body;

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

    // Must be a real Next.js path (not a legacy hash route). Supabase appends
    // `#access_token=...&type=recovery` to this URL.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${frontendUrl}/reset-password`,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update password (after reset)
router.post('/update-password', async (req: Request, res: Response) => {
  try {
    const { password, accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Access token is required' });
    }

    // Verify the token first
    const { data: { user }, error: verifyError } = await supabase.auth.getUser(accessToken);

    if (verifyError || !user) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Update password using admin client
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', req.user!.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar: user.avatar,
      timezone: user.timezone || undefined,
      createdAt: user.created_at,
      onboardingCompletedAt: user.onboarding_completed_at || null,
      onboardingStepIds: Array.isArray(user.onboarding_step_ids) ? user.onboarding_step_ids : [],
      weeklyLeadGoal: user.weekly_lead_goal,
      monthlyLeadGoal: user.monthly_lead_goal,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter };
