import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/resources ──────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = String(req.user!.role || '').toUpperCase();
    let query = supabaseAdmin
      .from('resources')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true });

    // Non-admins only see active resources
    if (role !== 'ADMIN') {
      query = query.eq('is_active', true);
    }

    const { data: resources, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ resources: resources || [] });
  } catch (error: any) {
    console.error('List resources error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/resources ─────────────────────────────────────────────
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      title,
      url,
      estimatedTime = '5m',
      category = 'General',
      icon = 'BookOpen',
      sortOrder = 0,
      isActive = true,
    } = req.body;

    if (!title || !url) {
      return res.status(400).json({ error: 'Title and URL are required' });
    }

    const { data: resource, error } = await supabaseAdmin
      .from('resources')
      .insert({
        title,
        url,
        estimated_time: estimatedTime,
        category,
        icon,
        sort_order: sortOrder,
        is_active: isActive,
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(resource);
  } catch (error: any) {
    console.error('Create resource error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/resources/:id ──────────────────────────────────────────
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('resources')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.url !== undefined) dbUpdates.url = updates.url;
    if (updates.estimatedTime !== undefined) dbUpdates.estimated_time = updates.estimatedTime;
    if (updates.estimated_time !== undefined) dbUpdates.estimated_time = updates.estimated_time;
    if (updates.category !== undefined) dbUpdates.category = updates.category;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    if (updates.sort_order !== undefined) dbUpdates.sort_order = updates.sort_order;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;
    if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;

    const { data: updated, error } = await supabaseAdmin
      .from('resources')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update resource error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/resources/:id ───────────────────────────────────────
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('resources')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    const { error } = await supabaseAdmin.from('resources').delete().eq('id', id);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Resource deleted successfully' });
  } catch (error: any) {
    console.error('Delete resource error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const resourcesRouter = router;
