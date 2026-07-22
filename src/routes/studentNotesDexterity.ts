import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const NOTE_TAGS = new Set(['Risk', 'Strength', 'Academic', 'Interview']);

async function assertStudentAccess(
  req: AuthRequest,
  studentId: string,
  opts: { write?: boolean; notesWrite?: boolean } = {},
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const requesterId = req.user?.id;
  const role = req.user?.role;
  if (!requesterId || !role) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const { data: profile } = await supabaseAdmin
    .from('student_profiles')
    .select('mentor_id')
    .eq('id', studentId)
    .maybeSingle();

  if (!profile) {
    return { ok: false, status: 404, error: 'Student not found' };
  }

  const isSelf = role === 'STUDENT' && requesterId === studentId;
  const isAssignedMentor = role === 'MENTOR' && profile.mentor_id === requesterId;
  const isStaff = role === 'ADMIN' || role === 'MENTOR_MANAGER' || isAssignedMentor;

  if (opts.notesWrite) {
    if (!isStaff) {
      return { ok: false, status: 403, error: 'Only staff can write mentor notes' };
    }
    return { ok: true };
  }

  if (opts.write) {
    // Dexterity: staff or student self
    if (isStaff || isSelf) return { ok: true };
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  // Read
  if (isStaff || isSelf) return { ok: true };
  return { ok: false, status: 403, error: 'Forbidden' };
}

function mapNote(row: any) {
  const author = row.author || row.users || null;
  return {
    id: row.id,
    studentId: row.student_id,
    authorId: row.author_id,
    authorName: author?.name || 'Unknown',
    content: row.content,
    tags: Array.isArray(row.tags) ? row.tags : [],
    timestamp: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDexterity(row: any) {
  return {
    id: row.id,
    studentId: row.student_id,
    activity: row.activity,
    description: row.description || '',
    startDate: row.start_date,
    endDate: row.end_date || undefined,
    isOngoing: !!row.is_ongoing,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => typeof t === 'string' && NOTE_TAGS.has(t));
}

/** Register notes + dexterity CRUD under /api/students/:id/... */
export function registerNotesDexterityRoutes(router: Router) {
  // ── Notes ──────────────────────────────────────────────────────────

  router.get('/:id/notes', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const access = await assertStudentAccess(req, id);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { data, error } = await supabaseAdmin
        .from('student_notes')
        .select('*, author:users!student_notes_author_id_fkey(id, name)')
        .eq('student_id', id)
        .order('created_at', { ascending: false });

      if (error) {
        // Fallback without FK hint if relation name differs
        const fallback = await supabaseAdmin
          .from('student_notes')
          .select('*')
          .eq('student_id', id)
          .order('created_at', { ascending: false });

        if (fallback.error) {
          return res.status(500).json({ error: fallback.error.message });
        }

        const authorIds = [...new Set((fallback.data || []).map((n) => n.author_id))];
        const { data: authors } = authorIds.length
          ? await supabaseAdmin.from('users').select('id, name').in('id', authorIds)
          : { data: [] as { id: string; name: string }[] };
        const byId = new Map((authors || []).map((a) => [a.id, a]));

        return res.json({
          notes: (fallback.data || []).map((n) =>
            mapNote({ ...n, author: byId.get(n.author_id) }),
          ),
        });
      }

      res.json({ notes: (data || []).map(mapNote) });
    } catch (error: any) {
      console.error('Error listing notes:', error);
      res.status(500).json({ error: error.message || 'Server error listing notes' });
    }
  });

  router.post('/:id/notes', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const access = await assertStudentAccess(req, id, { notesWrite: true });
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      if (!content) return res.status(400).json({ error: 'Content is required' });

      const tags = sanitizeTags(req.body?.tags);
      const authorId = req.user!.id;

      const { data, error } = await supabaseAdmin
        .from('student_notes')
        .insert({
          student_id: id,
          author_id: authorId,
          content,
          tags,
        })
        .select('*')
        .single();

      if (error) return res.status(500).json({ error: error.message });

      const { data: author } = await supabaseAdmin
        .from('users')
        .select('id, name')
        .eq('id', authorId)
        .maybeSingle();

      res.status(201).json({ note: mapNote({ ...data, author }) });
    } catch (error: any) {
      console.error('Error creating note:', error);
      res.status(500).json({ error: error.message || 'Server error creating note' });
    }
  });

  router.put('/:id/notes/:noteId', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id, noteId } = req.params;
      const access = await assertStudentAccess(req, id, { notesWrite: true });
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (typeof req.body?.content === 'string') {
        const content = req.body.content.trim();
        if (!content) return res.status(400).json({ error: 'Content is required' });
        updates.content = content;
      }
      if (req.body?.tags !== undefined) {
        updates.tags = sanitizeTags(req.body.tags);
      }

      const { data, error } = await supabaseAdmin
        .from('student_notes')
        .update(updates)
        .eq('id', noteId)
        .eq('student_id', id)
        .select('*')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Note not found' });

      const { data: author } = await supabaseAdmin
        .from('users')
        .select('id, name')
        .eq('id', data.author_id)
        .maybeSingle();

      res.json({ note: mapNote({ ...data, author }) });
    } catch (error: any) {
      console.error('Error updating note:', error);
      res.status(500).json({ error: error.message || 'Server error updating note' });
    }
  });

  router.delete('/:id/notes/:noteId', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id, noteId } = req.params;
      const access = await assertStudentAccess(req, id, { notesWrite: true });
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { data, error } = await supabaseAdmin
        .from('student_notes')
        .delete()
        .eq('id', noteId)
        .eq('student_id', id)
        .select('id')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Note not found' });

      res.json({ message: 'Note deleted' });
    } catch (error: any) {
      console.error('Error deleting note:', error);
      res.status(500).json({ error: error.message || 'Server error deleting note' });
    }
  });

  // ── Dexterity ──────────────────────────────────────────────────────

  router.get('/:id/dexterity', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const access = await assertStudentAccess(req, id);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { data, error } = await supabaseAdmin
        .from('student_dexterity')
        .select('*')
        .eq('student_id', id)
        .order('start_date', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      res.json({ items: (data || []).map(mapDexterity) });
    } catch (error: any) {
      console.error('Error listing dexterity:', error);
      res.status(500).json({ error: error.message || 'Server error listing dexterity' });
    }
  });

  router.post('/:id/dexterity', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const access = await assertStudentAccess(req, id, { write: true });
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const activity = typeof req.body?.activity === 'string' ? req.body.activity.trim() : '';
      const description =
        typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      const startDate = req.body?.startDate || req.body?.start_date;
      const endDate = req.body?.endDate ?? req.body?.end_date ?? null;
      const isOngoing = !!(req.body?.isOngoing ?? req.body?.is_ongoing);

      if (!activity) return res.status(400).json({ error: 'Activity is required' });
      if (!startDate) return res.status(400).json({ error: 'Start date is required' });

      const { data, error } = await supabaseAdmin
        .from('student_dexterity')
        .insert({
          student_id: id,
          activity,
          description,
          start_date: startDate,
          end_date: isOngoing ? null : endDate || null,
          is_ongoing: isOngoing,
        })
        .select('*')
        .single();

      if (error) return res.status(500).json({ error: error.message });
      res.status(201).json({ item: mapDexterity(data) });
    } catch (error: any) {
      console.error('Error creating dexterity:', error);
      res.status(500).json({ error: error.message || 'Server error creating dexterity' });
    }
  });

  router.put('/:id/dexterity/:itemId', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id, itemId } = req.params;
      const access = await assertStudentAccess(req, id, { write: true });
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (typeof req.body?.activity === 'string') {
        const activity = req.body.activity.trim();
        if (!activity) return res.status(400).json({ error: 'Activity is required' });
        updates.activity = activity;
      }
      if (typeof req.body?.description === 'string') {
        updates.description = req.body.description.trim();
      }
      if (req.body?.startDate !== undefined || req.body?.start_date !== undefined) {
        updates.start_date = req.body.startDate ?? req.body.start_date;
      }
      if (req.body?.endDate !== undefined || req.body?.end_date !== undefined) {
        updates.end_date = req.body.endDate ?? req.body.end_date;
      }
      if (req.body?.isOngoing !== undefined || req.body?.is_ongoing !== undefined) {
        const isOngoing = !!(req.body.isOngoing ?? req.body.is_ongoing);
        updates.is_ongoing = isOngoing;
        if (isOngoing) updates.end_date = null;
      }

      const { data, error } = await supabaseAdmin
        .from('student_dexterity')
        .update(updates)
        .eq('id', itemId)
        .eq('student_id', id)
        .select('*')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Dexterity item not found' });

      res.json({ item: mapDexterity(data) });
    } catch (error: any) {
      console.error('Error updating dexterity:', error);
      res.status(500).json({ error: error.message || 'Server error updating dexterity' });
    }
  });

  router.delete('/:id/dexterity/:itemId', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { id, itemId } = req.params;
      const access = await assertStudentAccess(req, id, { write: true });
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { data, error } = await supabaseAdmin
        .from('student_dexterity')
        .delete()
        .eq('id', itemId)
        .eq('student_id', id)
        .select('id')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Dexterity item not found' });

      res.json({ message: 'Dexterity item deleted' });
    } catch (error: any) {
      console.error('Error deleting dexterity:', error);
      res.status(500).json({ error: error.message || 'Server error deleting dexterity' });
    }
  });
}
