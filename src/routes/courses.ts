import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

async function attachModules(courseIds: string[]) {
  if (courseIds.length === 0) return {} as Record<string, any[]>;
  const { data: modules } = await supabaseAdmin
    .from('course_modules')
    .select('*')
    .in('course_id', courseIds)
    .order('sort_order', { ascending: true });

  const byCourse: Record<string, any[]> = {};
  (modules || []).forEach((m) => {
    if (!byCourse[m.course_id]) byCourse[m.course_id] = [];
    byCourse[m.course_id].push(m);
  });
  return byCourse;
}

// Static paths MUST come before /:id

// ─── GET /api/courses ────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = String(req.user!.role || '').toUpperCase();
    let query = supabaseAdmin
      .from('courses')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true });

    if (role === 'STUDENT') {
      query = query.eq('status', 'PUBLISHED');
    }

    const { data: courses, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const list = courses || [];
    const modulesByCourse = await attachModules(list.map((c) => c.id));
    res.json({
      courses: list.map((c) => ({ ...c, modules: modulesByCourse[c.id] || [] })),
    });
  } catch (error: any) {
    console.error('List courses error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/courses/submissions ────────────────────────────────────
router.get('/submissions', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;
    let query = supabaseAdmin
      .from('course_submissions')
      .select('*')
      .order('created_at', { ascending: false });

    if (status && status !== 'ALL') {
      query = query.eq('status', String(status).toUpperCase());
    }

    const { data: submissions, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = submissions || [];
    const studentIds = [...new Set(rows.map((s) => s.student_id).filter(Boolean))];
    const courseIds = [...new Set(rows.map((s) => s.course_id).filter(Boolean))];
    const moduleIds = [...new Set(rows.map((s) => s.module_id).filter(Boolean))];

    const [{ data: users }, { data: courses }, { data: modules }] = await Promise.all([
      studentIds.length
        ? supabaseAdmin.from('users').select('id, name, email, avatar').in('id', studentIds)
        : Promise.resolve({ data: [] as any[] }),
      courseIds.length
        ? supabaseAdmin.from('courses').select('id, title').in('id', courseIds)
        : Promise.resolve({ data: [] as any[] }),
      moduleIds.length
        ? supabaseAdmin.from('course_modules').select('id, title, type').in('id', moduleIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const userMap = Object.fromEntries((users || []).map((u) => [u.id, u]));
    const courseMap = Object.fromEntries((courses || []).map((c) => [c.id, c]));
    const moduleMap = Object.fromEntries((modules || []).map((m) => [m.id, m]));

    res.json({
      submissions: rows.map((s) => ({
        ...s,
        student: userMap[s.student_id] || null,
        course: courseMap[s.course_id] || null,
        module: s.module_id ? moduleMap[s.module_id] || null : null,
      })),
    });
  } catch (error: any) {
    console.error('List course submissions error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/courses/submissions/:submissionId ──────────────────────
router.put('/submissions/:submissionId', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { submissionId } = req.params;
    const { status, reviewerNotes } = req.body;

    if (!status) return res.status(400).json({ error: 'status is required' });

    const dbUpdates: Record<string, unknown> = {
      status,
      reviewer_id: req.user!.id,
      reviewer_notes: reviewerNotes ?? null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: submission, error } = await supabaseAdmin
      .from('course_submissions')
      .update(dbUpdates)
      .eq('id', submissionId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(submission);
  } catch (error: any) {
    console.error('Review submission error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/courses/modules/:moduleId ──────────────────────────────
router.put('/modules/:moduleId', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { moduleId } = req.params;
    const updates = req.body;

    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.contentUrl !== undefined) dbUpdates.content_url = updates.contentUrl;
    if (updates.content_url !== undefined) dbUpdates.content_url = updates.content_url;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    if (updates.sort_order !== undefined) dbUpdates.sort_order = updates.sort_order;
    if (updates.isRequired !== undefined) dbUpdates.is_required = updates.isRequired;
    if (updates.is_required !== undefined) dbUpdates.is_required = updates.is_required;

    const { data: module, error } = await supabaseAdmin
      .from('course_modules')
      .update(dbUpdates)
      .eq('id', moduleId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(module);
  } catch (error: any) {
    console.error('Update module error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/courses/modules/:moduleId ───────────────────────────
router.delete('/modules/:moduleId', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { moduleId } = req.params;
    const { error } = await supabaseAdmin.from('course_modules').delete().eq('id', moduleId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Module deleted successfully' });
  } catch (error: any) {
    console.error('Delete module error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/courses ───────────────────────────────────────────────
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      title,
      description,
      category = 'General',
      status = 'DRAFT',
      sortOrder = 0,
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    const { data: course, error } = await supabaseAdmin
      .from('courses')
      .insert({
        title: title.trim(),
        description: description || null,
        category,
        status,
        sort_order: sortOrder,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ ...course, modules: [] });
  } catch (error: any) {
    console.error('Create course error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/courses/:id ────────────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const role = String(req.user!.role || '').toUpperCase();

    const { data: course, error } = await supabaseAdmin
      .from('courses')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !course) return res.status(404).json({ error: 'Course not found' });
    if (role === 'STUDENT' && course.status !== 'PUBLISHED') {
      return res.status(404).json({ error: 'Course not found' });
    }

    const modulesByCourse = await attachModules([id]);
    res.json({ ...course, modules: modulesByCourse[id] || [] });
  } catch (error: any) {
    console.error('Get course error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/courses/:id ────────────────────────────────────────────
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('courses')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Course not found' });

    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.category !== undefined) dbUpdates.category = updates.category;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    if (updates.sort_order !== undefined) dbUpdates.sort_order = updates.sort_order;

    const { data: course, error } = await supabaseAdmin
      .from('courses')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const modulesByCourse = await attachModules([id]);
    res.json({ ...course, modules: modulesByCourse[id] || [] });
  } catch (error: any) {
    console.error('Update course error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/courses/:id ─────────────────────────────────────────
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('courses').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Course deleted successfully' });
  } catch (error: any) {
    console.error('Delete course error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/courses/:id/modules ───────────────────────────────────
router.post('/:id/modules', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const courseId = req.params.id;
    const {
      title,
      description,
      type = 'VIDEO',
      contentUrl,
      sortOrder = 0,
      isRequired = true,
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    const { data: course } = await supabaseAdmin
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .maybeSingle();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const { data: module, error } = await supabaseAdmin
      .from('course_modules')
      .insert({
        course_id: courseId,
        title: title.trim(),
        description: description || null,
        type,
        content_url: contentUrl || null,
        sort_order: sortOrder,
        is_required: isRequired,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(module);
  } catch (error: any) {
    console.error('Create module error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/courses/:id/submissions ───────────────────────────────
router.post('/:id/submissions', async (req: AuthRequest, res: Response) => {
  try {
    const courseId = req.params.id;
    const studentId = req.user!.id;
    const { moduleId, type = 'WORKSHEET', title, fileUrl, notes } = req.body;

    const { data: course } = await supabaseAdmin
      .from('courses')
      .select('id, status')
      .eq('id', courseId)
      .maybeSingle();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const { data: submission, error } = await supabaseAdmin
      .from('course_submissions')
      .insert({
        course_id: courseId,
        module_id: moduleId || null,
        student_id: studentId,
        type,
        title: title || null,
        file_url: fileUrl || null,
        notes: notes || null,
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(submission);
  } catch (error: any) {
    console.error('Create submission error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const coursesRouter = router;
