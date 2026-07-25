import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

function mapRow(row: any) {
  return {
    id: row.id,
    key: row.metric_key,
    label: row.label,
    benchmark: Number(row.benchmark),
    unit: row.unit ?? '',
    description: row.description ?? '',
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/national-benchmarks — all authenticated users (students need these in Hub Analytics)
router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('national_benchmarks')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ benchmarks: (data || []).map(mapRow) });
  } catch (error: any) {
    console.error('Fetch national benchmarks error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /api/national-benchmarks — admin create
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { key, label, benchmark, unit, description, sortOrder } = req.body;

    if (!key || !label || benchmark === undefined || benchmark === null) {
      return res.status(400).json({ error: 'key, label, and benchmark are required' });
    }

    let nextSort = sortOrder;
    if (nextSort === undefined || nextSort === null) {
      const { data: last } = await supabaseAdmin
        .from('national_benchmarks')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      nextSort = (last?.sort_order ?? -1) + 1;
    }

    const { data, error } = await supabaseAdmin
      .from('national_benchmarks')
      .insert({
        metric_key: String(key).trim(),
        label: String(label).trim(),
        benchmark: Number(benchmark),
        unit: unit != null ? String(unit) : '',
        description: description != null ? String(description) : '',
        sort_order: Number(nextSort),
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A benchmark with this metric key already exists' });
      }
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(mapRow(data));
  } catch (error: any) {
    console.error('Create national benchmark error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/national-benchmarks/reorder/bulk — admin bulk reorder
router.put('/reorder/bulk', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { orderedIds } = req.body as { orderedIds?: string[] };
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds array is required' });
    }

    await Promise.all(
      orderedIds.map((id, index) =>
        supabaseAdmin
          .from('national_benchmarks')
          .update({ sort_order: index })
          .eq('id', id),
      ),
    );

    const { data, error } = await supabaseAdmin
      .from('national_benchmarks')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ benchmarks: (data || []).map(mapRow) });
  } catch (error: any) {
    console.error('Reorder national benchmarks error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/national-benchmarks/:id — admin update
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { key, label, benchmark, unit, description, sortOrder } = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('national_benchmarks')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const dbUpdates: Record<string, unknown> = {};
    if (key !== undefined) dbUpdates.metric_key = String(key).trim();
    if (label !== undefined) dbUpdates.label = String(label).trim();
    if (benchmark !== undefined) dbUpdates.benchmark = Number(benchmark);
    if (unit !== undefined) dbUpdates.unit = String(unit);
    if (description !== undefined) dbUpdates.description = String(description);
    if (sortOrder !== undefined) dbUpdates.sort_order = Number(sortOrder);

    const { data, error } = await supabaseAdmin
      .from('national_benchmarks')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A benchmark with this metric key already exists' });
      }
      return res.status(400).json({ error: error.message });
    }

    res.json(mapRow(data));
  } catch (error: any) {
    console.error('Update national benchmark error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// DELETE /api/national-benchmarks/:id — admin delete
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('national_benchmarks')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const { error } = await supabaseAdmin
      .from('national_benchmarks')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Benchmark deleted' });
  } catch (error: any) {
    console.error('Delete national benchmark error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const nationalBenchmarksRouter = router;
