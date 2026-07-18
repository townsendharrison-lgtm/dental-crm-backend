import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/popups/active ──────────────────────────────────────────
// Fetch active popups targeting the caller's role (not dismissed yet)
router.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = String(req.user!.role || '').toUpperCase();
    const now = new Date().toISOString();

    // Query active campaigns within schedule bounds
    const { data: popups, error } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .eq('is_active', true)
      .lte('start_date', now)
      .gte('end_date', now);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Always enforce audience: BOTH or exact role match (never show STUDENT ads to MENTOR, etc.)
    const activeNonDismissed = (popups || []).filter((popup: any) => {
      const target = String(popup.target_role || 'BOTH').toUpperCase();
      const matchesRole = target === 'BOTH' || target === role;
      const notDismissed = !(popup.dismissed_by || []).includes(userId);
      return matchesRole && notDismissed;
    });

    res.json({ popups: activeNonDismissed });
  } catch (error: any) {
    console.error('Fetch active advertisements error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/popups ─────────────────────────────────────────────────
// Fetch all popups in directory (Admin / Manager only)
router.get('/', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { data: popups, error } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ popups: popups || [] });
  } catch (error: any) {
    console.error('List all advertisements error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/popups/:id ─────────────────────────────────────────────
// Fetch details of a single popup advertisement
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: popup, error } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !popup) {
      return res.status(404).json({ error: 'Advertisement template not found' });
    }

    res.json(popup);
  } catch (error: any) {
    console.error('Fetch advertisement error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/popups ────────────────────────────────────────────────
// Create a new popup advertisement campaign (Admin only)
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      title,
      message,
      imageUrl,
      ctaText,
      ctaUrl,
      backgroundColor,
      textColor,
      targetRole = 'BOTH',
      startDate,
      endDate,
      isActive = true
    } = req.body;

    if (!title || !message || !startDate || !endDate) {
      return res.status(400).json({ error: 'Title, message, startDate, and endDate are required' });
    }

    const { data: newPopup, error } = await supabaseAdmin
      .from('popup_advertisements')
      .insert({
        title,
        message,
        image_url: imageUrl || null,
        cta_text: ctaText || null,
        cta_url: ctaUrl || null,
        background_color: backgroundColor || null,
        text_color: textColor || null,
        target_role: targetRole,
        start_date: startDate,
        end_date: endDate,
        is_active: isActive,
        created_by: req.user!.id,
        dismissed_by: []
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newPopup);
  } catch (error: any) {
    console.error('Create advertisement campaign error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/popups/:id ─────────────────────────────────────────────
// Update popup advertisement configuration (Admin only)
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Advertisement not found' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.message !== undefined) dbUpdates.message = updates.message;
    if (updates.imageUrl !== undefined) dbUpdates.image_url = updates.imageUrl;
    if (updates.ctaText !== undefined) dbUpdates.cta_text = updates.ctaText;
    if (updates.ctaUrl !== undefined) dbUpdates.cta_url = updates.ctaUrl;
    if (updates.backgroundColor !== undefined) dbUpdates.background_color = updates.backgroundColor;
    if (updates.textColor !== undefined) dbUpdates.text_color = updates.textColor;
    if (updates.targetRole !== undefined) dbUpdates.target_role = updates.targetRole;
    if (updates.startDate !== undefined) dbUpdates.start_date = updates.startDate;
    if (updates.endDate !== undefined) dbUpdates.end_date = updates.endDate;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;
    if (updates.dismissedBy !== undefined) dbUpdates.dismissed_by = updates.dismissedBy;

    const { data: updated, error } = await supabaseAdmin
      .from('popup_advertisements')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update advertisement error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/popups/:id ──────────────────────────────────────────
// Delete popup advertisement campaign (Admin only)
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Advertisement template not found' });
    }

    const { error } = await supabaseAdmin
      .from('popup_advertisements')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Advertisement campaign deleted successfully' });
  } catch (error: any) {
    console.error('Delete advertisement error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/popups/:id/dismiss ────────────────────────────────────
// Dismiss a popup advertisement for the current caller user
router.post('/:id/dismiss', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Fetch existing popup dismissal record
    const { data: popup, error: fetchErr } = await supabaseAdmin
      .from('popup_advertisements')
      .select('id, dismissed_by')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !popup) {
      return res.status(404).json({ error: 'Advertisement not found' });
    }

    const dismissed = popup.dismissed_by || [];

    if (!dismissed.includes(userId)) {
      dismissed.push(userId);

      const { data: updated, error } = await supabaseAdmin
        .from('popup_advertisements')
        .update({
          dismissed_by: dismissed,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      return res.json(updated);
    }

    res.json(popup);
  } catch (error: any) {
    console.error('Dismiss advertisement error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const popupsRouter = router;
