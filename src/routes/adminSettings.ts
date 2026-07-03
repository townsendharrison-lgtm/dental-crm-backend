import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/admin-settings ─────────────────────────────────────────
// Fetch global platform configurations (available to all logged-in users)
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
// Update system configurations (Admin only)
router.put('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const updates = req.body;
    const dbUpdates: any = { updated_at: new Date().toISOString() };

    if (updates.platformName !== undefined) dbUpdates.platform_name = updates.platformName;
    if (updates.supportEmail !== undefined) dbUpdates.support_email = updates.supportEmail;
    if (updates.maintenanceMode !== undefined) dbUpdates.maintenance_mode = updates.maintenanceMode;
    if (updates.autoReplyEnabled !== undefined) dbUpdates.auto_reply_enabled = updates.autoReplyEnabled;
    if (updates.autoReplyMessage !== undefined) dbUpdates.auto_reply_message = updates.autoReplyMessage;
    if (updates.welcomeTemplateStudent !== undefined) dbUpdates.welcome_template_student = updates.welcomeTemplateStudent;
    if (updates.welcomeTemplateMentor !== undefined) dbUpdates.welcome_template_mentor = updates.welcomeTemplateMentor;

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

export const adminSettingsRouter = router;
