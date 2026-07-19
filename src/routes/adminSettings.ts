import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/admin-settings ─────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { data: settings, error } = await supabaseAdmin
      .from('admin_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!settings) {
      return res.status(404).json({ error: 'System settings record not found' });
    }

    res.json(settings);
  } catch (error: any) {
    console.error('Fetch system settings error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/admin-settings ─────────────────────────────────────────
router.put('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const updates = req.body;
    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (updates.platformName !== undefined) dbUpdates.platform_name = updates.platformName;
    if (updates.supportEmail !== undefined) dbUpdates.support_email = updates.supportEmail;
    if (updates.maintenanceMode !== undefined) dbUpdates.maintenance_mode = updates.maintenanceMode;
    if (updates.autoReplyEnabled !== undefined) dbUpdates.auto_reply_enabled = updates.autoReplyEnabled;
    if (updates.autoReplyMessage !== undefined) dbUpdates.auto_reply_message = updates.autoReplyMessage;
    if (updates.autoReplyInactivityMinutes !== undefined) {
      dbUpdates.auto_reply_inactivity_minutes = Number(updates.autoReplyInactivityMinutes);
    }
    if (updates.autoReplyRateLimitMinutes !== undefined) {
      dbUpdates.auto_reply_rate_limit_minutes = Number(updates.autoReplyRateLimitMinutes);
    }
    if (updates.welcomeTemplateStudent !== undefined) {
      dbUpdates.welcome_template_student = updates.welcomeTemplateStudent;
    }
    if (updates.welcomeTemplateMentor !== undefined) {
      dbUpdates.welcome_template_mentor = updates.welcomeTemplateMentor;
    }
    if (updates.acceptedMessage !== undefined) dbUpdates.accepted_message = updates.acceptedMessage;
    if (updates.interviewMessage !== undefined) dbUpdates.interview_message = updates.interviewMessage;
    if (updates.waitlistMessage !== undefined) dbUpdates.waitlist_message = updates.waitlistMessage;

    const { data: updated, error } = await supabaseAdmin
      .from('admin_settings')
      .update(dbUpdates)
      .eq('id', 1)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update system settings error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/admin-settings/reset-profile-reminders ────────────────
// Clears last_profile_reminder_at so the 5-day incomplete-profile check can fire again
router.post('/reset-profile-reminders', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { data: profiles, error: fetchErr } = await supabaseAdmin
      .from('student_profiles')
      .select('id');

    if (fetchErr) {
      return res.status(400).json({ error: fetchErr.message });
    }

    const ids = (profiles || []).map((p) => p.id);
    if (ids.length > 0) {
      const { error } = await supabaseAdmin
        .from('student_profiles')
        .update({ last_profile_reminder_at: null })
        .in('id', ids);

      if (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    const count = ids.length;

    // Notify incomplete-looking students so the simulate action is visible immediately
    const { data: students } = await supabaseAdmin
      .from('users')
      .select('id, name')
      .eq('role', 'STUDENT');

    if (students && students.length > 0) {
      const notifications = students.map((student) => ({
        user_id: student.id,
        title: 'Profile Completion Required',
        message: `Hi ${(student.name || 'there').split(' ')[0]}, please take a moment to complete your profile and upload any missing documents. This helps us ensure you stay on track!`,
        type: 'WARNING',
        category: 'PROFILE_REMINDER',
        is_read: false,
        created_by: req.user!.id,
      }));

      // Insert in chunks to avoid payload limits
      const chunkSize = 50;
      for (let i = 0; i < notifications.length; i += chunkSize) {
        await supabaseAdmin.from('notifications').insert(notifications.slice(i, i + chunkSize));
      }
    }

    res.json({
      success: true,
      resetCount: count,
      message: `Reset reminder timers for ${count} student profile(s).`,
    });
  } catch (error: any) {
    console.error('Reset profile reminders error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const adminSettingsRouter = router;
