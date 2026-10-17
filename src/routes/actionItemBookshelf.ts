import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const PRIORITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

function normalizePriority(raw: unknown): 'HIGH' | 'MEDIUM' | 'LOW' {
  const value = String(raw || 'MEDIUM').trim().toUpperCase();
  return PRIORITIES.has(value) ? (value as 'HIGH' | 'MEDIUM' | 'LOW') : 'MEDIUM';
}

function mapItem(row: any) {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description || '',
    priority: normalizePriority(row.priority),
    resourceLink: row.resource_link || '',
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function missingTable(error: any) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /action_item_bookshelf/i.test(message)
  );
}

function tableMissingResponse(res: Response) {
  return res.status(503).json({
    error: 'Action item bookshelf is not set up yet. Run migration 065_action_item_bookshelf.sql.',
  });
}

/**
 * GET /api/action-item-bookshelf
 * Mentors, mentor managers, and admins: platform list + their own bookshelf.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;

    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot access the action item bookshelf' });
    }
    if (role !== 'MENTOR' && role !== 'ADMIN' && role !== 'MENTOR_MANAGER') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabaseAdmin
      .from('action_item_bookshelf')
      .select('*')
      .or(`scope.eq.GLOBAL,and(scope.eq.MENTOR,owner_id.eq.${userId})`)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true });

    if (error) {
      if (missingTable(error)) return tableMissingResponse(res);
      return res.status(500).json({ error: error.message });
    }

    res.json({ items: (data || []).map(mapItem) });
  } catch (error: any) {
    console.error('List action item bookshelf error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * POST /api/action-item-bookshelf
 * Admin / mentor manager → GLOBAL unless scope is MENTOR.
 * Mentor → personal bookshelf only.
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;
    const { title, description, priority, resourceLink, resource_link, sortOrder, scope: requestedScope } =
      req.body || {};

    if (!String(title || '').trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    let scope: 'GLOBAL' | 'MENTOR';
    let ownerId: string | null = null;

    if (role === 'ADMIN' || role === 'MENTOR_MANAGER') {
      scope = requestedScope === 'MENTOR' ? 'MENTOR' : 'GLOBAL';
      if (scope === 'MENTOR') ownerId = userId;
    } else if (role === 'MENTOR') {
      scope = 'MENTOR';
      ownerId = userId;
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    let nextSort = Number(sortOrder);
    if (!Number.isFinite(nextSort)) {
      let sortQuery = supabaseAdmin
        .from('action_item_bookshelf')
        .select('sort_order')
        .eq('scope', scope)
        .order('sort_order', { ascending: false })
        .limit(1);
      sortQuery = ownerId ? sortQuery.eq('owner_id', ownerId) : sortQuery.is('owner_id', null);
      const { data: existing } = await sortQuery;
      nextSort = existing?.[0]?.sort_order != null ? Number(existing[0].sort_order) + 1 : 0;
    }

    const link = String(resourceLink ?? resource_link ?? '').trim();

    const { data, error } = await supabaseAdmin
      .from('action_item_bookshelf')
      .insert({
        scope,
        owner_id: ownerId,
        title: String(title).trim(),
        description: description != null ? String(description).trim() || null : null,
        priority: normalizePriority(priority),
        resource_link: link || null,
        sort_order: nextSort,
      })
      .select('*')
      .single();

    if (error) {
      if (missingTable(error)) return tableMissingResponse(res);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(mapItem(data));
  } catch (error: any) {
    console.error('Create action item bookshelf error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;
    const { id } = req.params;
    const { title, description, priority, resourceLink, resource_link, sortOrder } = req.body || {};

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('action_item_bookshelf')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) {
      if (missingTable(fetchErr)) return tableMissingResponse(res);
      return res.status(500).json({ error: fetchErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Bookshelf item not found' });

    const isAdmin = role === 'ADMIN' || role === 'MENTOR_MANAGER';
    if (existing.scope === 'GLOBAL' && !isAdmin) {
      return res.status(403).json({ error: 'Only admins can edit the shared action item list' });
    }
    if (existing.scope === 'MENTOR' && existing.owner_id !== userId && !isAdmin) {
      return res.status(403).json({ error: 'You can only edit your own bookshelf' });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = String(title).trim();
    if (description !== undefined) updates.description = String(description).trim() || null;
    if (priority !== undefined) updates.priority = normalizePriority(priority);
    if (resourceLink !== undefined || resource_link !== undefined) {
      const link = String(resourceLink ?? resource_link ?? '').trim();
      updates.resource_link = link || null;
    }
    if (sortOrder !== undefined) updates.sort_order = Number(sortOrder) || 0;

    const { data, error } = await supabaseAdmin
      .from('action_item_bookshelf')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(mapItem(data));
  } catch (error: any) {
    console.error('Update action item bookshelf error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('action_item_bookshelf')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) {
      if (missingTable(fetchErr)) return tableMissingResponse(res);
      return res.status(500).json({ error: fetchErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Bookshelf item not found' });

    const isAdmin = role === 'ADMIN' || role === 'MENTOR_MANAGER';
    if (existing.scope === 'GLOBAL' && !isAdmin) {
      return res.status(403).json({ error: 'Only admins can delete shared action items' });
    }
    if (existing.scope === 'MENTOR' && existing.owner_id !== userId && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own bookshelf items' });
    }

    const { error } = await supabaseAdmin.from('action_item_bookshelf').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Bookshelf item deleted' });
  } catch (error: any) {
    console.error('Delete action item bookshelf error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const actionItemBookshelfRouter = router;
