import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

const popupImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Use PNG, JPG, WebP, or GIF.'));
  },
});

function popupImagePath(userId: string, originalName: string) {
  const ext = (originalName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${userId}/${Date.now()}.${ext || 'jpg'}`;
}

async function clickCountsByPopupId(popupIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (popupIds.length === 0) return map;

  const { data, error } = await supabaseAdmin
    .from('popup_cta_clicks')
    .select('popup_id')
    .in('popup_id', popupIds);

  if (error) {
    console.warn('popup click count query failed:', error.message);
    return map;
  }

  for (const row of data || []) {
    const id = row.popup_id as string;
    map.set(id, (map.get(id) || 0) + 1);
  }
  return map;
}

// All routes require authentication
router.use(authenticate);

// ─── GET /api/popups/active ──────────────────────────────────────────
router.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = String(req.user!.role || '').toUpperCase();
    const now = new Date().toISOString();

    const { data: popups, error } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .eq('is_active', true)
      .lte('start_date', now)
      .gte('end_date', now);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

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

// ─── POST /api/popups/upload ─────────────────────────────────────────
// Upload a campaign image to Supabase Storage (Admin only)
router.post(
  '/upload',
  authorize('ADMIN'),
  (req: AuthRequest, res: Response, next: NextFunction) => {
    popupImageUpload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'File upload failed';
        return res.status(400).json({ error: message });
      }
      next();
    });
  },
  async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'Image file is required' });
      }

      const filePath = popupImagePath(req.user!.id, file.originalname);
      const { error: uploadError } = await supabaseAdmin.storage
        .from('popup-images')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('Popup image upload error:', uploadError.message);
        return res.status(500).json({ error: 'Image upload failed: ' + uploadError.message });
      }

      const { data: publicData } = supabaseAdmin.storage
        .from('popup-images')
        .getPublicUrl(filePath);

      res.status(201).json({
        url: publicData.publicUrl,
        path: filePath,
      });
    } catch (error: any) {
      console.error('Popup upload error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  },
);

// ─── GET /api/popups ─────────────────────────────────────────────────
router.get('/', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { data: popups, error } = await supabaseAdmin
      .from('popup_advertisements')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const list = popups || [];
    const counts = await clickCountsByPopupId(list.map((p) => p.id));
    const enriched = list.map((p) => ({
      ...p,
      click_count: counts.get(p.id) || 0,
      dismiss_count: (p.dismissed_by || []).length,
    }));

    res.json({ popups: enriched });
  } catch (error: any) {
    console.error('List all advertisements error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/popups/:id/analytics ───────────────────────────────────
router.get('/:id/analytics', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: popup, error: popupErr } = await supabaseAdmin
      .from('popup_advertisements')
      .select('id, title, dismissed_by')
      .eq('id', id)
      .maybeSingle();

    if (popupErr || !popup) {
      return res.status(404).json({ error: 'Advertisement not found' });
    }

    const { data: clicks, error: clickErr } = await supabaseAdmin
      .from('popup_cta_clicks')
      .select('user_id, clicked_at')
      .eq('popup_id', id)
      .order('clicked_at', { ascending: false });

    if (clickErr) {
      return res.status(500).json({ error: clickErr.message });
    }

    const clickRows = clicks || [];
    const userIds = Array.from(new Set(clickRows.map((c) => c.user_id)));
    let usersMap = new Map<string, { id: string; name: string; email: string; role: string }>();

    if (userIds.length > 0) {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('id, name, email, role')
        .in('id', userIds);
      usersMap = new Map((users || []).map((u) => [u.id, u]));
    }

    res.json({
      popupId: id,
      title: popup.title,
      dismissCount: (popup.dismissed_by || []).length,
      clickCount: clickRows.length,
      clicks: clickRows.map((c) => {
        const u = usersMap.get(c.user_id);
        return {
          userId: c.user_id,
          name: u?.name || 'Unknown',
          email: u?.email || '',
          role: u?.role || '',
          clickedAt: c.clicked_at,
        };
      }),
    });
  } catch (error: any) {
    console.error('Popup analytics error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/popups/:id/click ──────────────────────────────────────
router.post('/:id/click', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const { data: popup, error: fetchErr } = await supabaseAdmin
      .from('popup_advertisements')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !popup) {
      return res.status(404).json({ error: 'Advertisement not found' });
    }

    const { error } = await supabaseAdmin.from('popup_cta_clicks').upsert(
      {
        popup_id: id,
        user_id: userId,
        clicked_at: new Date().toISOString(),
      },
      { onConflict: 'popup_id,user_id' },
    );

    if (error) {
      console.error('Record CTA click error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('CTA click error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/popups/:id ─────────────────────────────────────────────
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
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      title,
      message,
      imageUrl,
      imageFit,
      imageHeight,
      ctaText,
      ctaUrl,
      backgroundColor,
      textColor,
      targetRole = 'BOTH',
      startDate,
      endDate,
      isActive = true,
    } = req.body;

    if (!title || !message || !startDate || !endDate) {
      return res.status(400).json({ error: 'Title, message, startDate, and endDate are required' });
    }

    const fit =
      imageFit === 'contain' || imageFit === 'original' || imageFit === 'cover'
        ? imageFit
        : 'cover';
    const height =
      imageHeight === 'sm' || imageHeight === 'md' || imageHeight === 'lg' ? imageHeight : 'md';

    const { data: newPopup, error } = await supabaseAdmin
      .from('popup_advertisements')
      .insert({
        title,
        message,
        image_url: imageUrl || null,
        image_fit: fit,
        image_height: height,
        cta_text: ctaText || null,
        cta_url: ctaUrl || null,
        background_color: backgroundColor || null,
        text_color: textColor || null,
        target_role: targetRole,
        start_date: startDate,
        end_date: endDate,
        is_active: isActive,
        created_by: req.user!.id,
        dismissed_by: [],
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
    if (updates.imageUrl !== undefined) dbUpdates.image_url = updates.imageUrl || null;
    if (updates.imageFit !== undefined) {
      dbUpdates.image_fit =
        updates.imageFit === 'contain' ||
        updates.imageFit === 'original' ||
        updates.imageFit === 'cover'
          ? updates.imageFit
          : 'cover';
    }
    if (updates.imageHeight !== undefined) {
      dbUpdates.image_height =
        updates.imageHeight === 'sm' ||
        updates.imageHeight === 'md' ||
        updates.imageHeight === 'lg'
          ? updates.imageHeight
          : 'md';
    }
    if (updates.ctaText !== undefined) dbUpdates.cta_text = updates.ctaText || null;
    if (updates.ctaUrl !== undefined) dbUpdates.cta_url = updates.ctaUrl || null;
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
router.post('/:id/dismiss', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

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
          updated_at: new Date().toISOString(),
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
