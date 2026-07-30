import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const CARD_TYPES = new Set(['Meeting', 'Milestone', 'Task', 'Other']);

function normalizeCardType(raw: unknown): string {
  const v = String(raw || 'Milestone').trim();
  return CARD_TYPES.has(v) ? v : 'Milestone';
}

function normalizeResourceLinks(raw: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const url = String(r.url || '').trim();
      if (!url) return null;
      return {
        label: String(r.label || url).trim() || url,
        url,
      };
    })
    .filter(Boolean) as Array<{ label: string; url: string }>;
}

function mapItem(row: any) {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    cardType: row.card_type || 'Milestone',
    title: row.title,
    description: row.description || '',
    resourceLinks: Array.isArray(row.resource_links) ? row.resource_links : [],
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /api/timeline-bookshelf
 * Mentors/admins: GLOBAL + (for mentors) own MENTOR items.
 * Students: 403
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;

    if (role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot access the preset bookshelf' });
    }

    let query = supabaseAdmin
      .from('timeline_bookshelf_items')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (role === 'MENTOR') {
      query = query.or(`scope.eq.GLOBAL,and(scope.eq.MENTOR,owner_id.eq.${userId})`);
    } else if (role === 'ADMIN' || role === 'MENTOR_MANAGER') {
      // Admins see all GLOBAL + optionally filter mentor ones later; default GLOBAL only for manage UI
      const includeMentor = req.query.includeMentor === 'true';
      if (!includeMentor) {
        query = query.eq('scope', 'GLOBAL');
      }
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const { data: settings } = await supabaseAdmin
      .from('admin_settings')
      .select('timeline_card_colors')
      .eq('id', 1)
      .maybeSingle();

    res.json({
      items: (data || []).map(mapItem),
      cardColors: settings?.timeline_card_colors || {
        Meeting: '#6366f1',
        Milestone: '#10b981',
        Task: '#f59e0b',
        Other: '#94a3b8',
      },
    });
  } catch (error: any) {
    console.error('List timeline bookshelf error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * POST /api/timeline-bookshelf
 * Admin → GLOBAL; Mentor → MENTOR owned by self
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;
    const { title, cardType, description, resourceLinks, sortOrder, scope: requestedScope } = req.body;

    if (!title?.trim()) {
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
      let q = supabaseAdmin
        .from('timeline_bookshelf_items')
        .select('sort_order')
        .eq('scope', scope)
        .order('sort_order', { ascending: false })
        .limit(1);
      if (ownerId) q = q.eq('owner_id', ownerId);
      else q = q.is('owner_id', null);
      const { data: existing } = await q;
      nextSort = existing?.[0]?.sort_order != null ? Number(existing[0].sort_order) + 1 : 0;
    }

    const { data, error } = await supabaseAdmin
      .from('timeline_bookshelf_items')
      .insert({
        scope,
        owner_id: ownerId,
        title: title.trim(),
        card_type: normalizeCardType(cardType),
        description: description != null ? String(description) : null,
        resource_links: normalizeResourceLinks(resourceLinks),
        sort_order: nextSort,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(mapItem(data));
  } catch (error: any) {
    console.error('Create timeline bookshelf item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * PUT /api/timeline-bookshelf/:id
 */
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;
    const { id } = req.params;
    const { title, cardType, description, resourceLinks, sortOrder } = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('timeline_bookshelf_items')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Bookshelf item not found' });
    }

    const isAdmin = role === 'ADMIN' || role === 'MENTOR_MANAGER';
    if (existing.scope === 'GLOBAL' && !isAdmin) {
      return res.status(403).json({ error: 'Only admins can edit platform presets' });
    }
    if (existing.scope === 'MENTOR' && existing.owner_id !== userId && !isAdmin) {
      return res.status(403).json({ error: 'You can only edit your own presets' });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = String(title).trim();
    if (cardType !== undefined) updates.card_type = normalizeCardType(cardType);
    if (description !== undefined) updates.description = String(description);
    if (resourceLinks !== undefined) updates.resource_links = normalizeResourceLinks(resourceLinks);
    if (sortOrder !== undefined) updates.sort_order = Number(sortOrder) || 0;

    const { data, error } = await supabaseAdmin
      .from('timeline_bookshelf_items')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(mapItem(data));
  } catch (error: any) {
    console.error('Update timeline bookshelf item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * DELETE /api/timeline-bookshelf/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('timeline_bookshelf_items')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Bookshelf item not found' });
    }

    const isAdmin = role === 'ADMIN' || role === 'MENTOR_MANAGER';
    if (existing.scope === 'GLOBAL' && !isAdmin) {
      return res.status(403).json({ error: 'Only admins can delete platform presets' });
    }
    if (existing.scope === 'MENTOR' && existing.owner_id !== userId && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own presets' });
    }

    const { error } = await supabaseAdmin.from('timeline_bookshelf_items').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Bookshelf item deleted' });
  } catch (error: any) {
    console.error('Delete timeline bookshelf item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const timelineBookshelfRouter = router;
