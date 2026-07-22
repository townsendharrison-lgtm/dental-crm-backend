import { Router, Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { SignInRequest, ResetPasswordRequest } from '../types/index.js';

const router = Router();

// Complete invitation — called after user clicks the Supabase invite email link
// The user arrives at the frontend with an access_token and sets their name + password
router.post('/complete-invitation', async (req: Request, res: Response) => {
  try {
    const { accessToken, name, password } = req.body;

    if (!accessToken || !name || !password) {
      return res.status(400).json({ error: 'Access token, name, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify the access token to identify the user
    const { data: { user: authUser }, error: verifyError } = await supabase.auth.getUser(accessToken);

    if (verifyError || !authUser) {
      return res.status(400).json({ error: 'Invalid or expired invitation link. Please ask admin to resend the invite.' });
    }

    // Get the role from user_metadata (set during invite)
    const role = authUser.user_metadata?.role || 'STUDENT';

    // Update the user's password and name in Supabase Auth
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      password,
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
    const role = user.user_metadata?.role || 'STUDENT';

    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.name || '',
        role
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

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${frontendUrl}/#/reset-password`
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

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter };
