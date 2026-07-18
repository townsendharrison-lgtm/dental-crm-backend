import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/surveys ────────────────────────────────────────────────
// List surveys (role filters: non-staff see active targeted surveys, staff see all)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const role = String(req.user!.role || '').toUpperCase();

    let query = supabaseAdmin
      .from('surveys')
      .select('*')
      .order('created_at', { ascending: false });

    // Filter by role if not Admin/Manager
    if (role !== 'ADMIN' && role !== 'MENTOR_MANAGER') {
      query = query
        .eq('is_active', true)
        .or(`target_role.eq.BOTH,target_role.eq.${role}`);
    }

    const { data: surveys, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const list = surveys || [];

    // Exact per-survey counts + latest submitted_at (avoids nested FK / row-limit issues)
    const statsEntries = await Promise.all(
      list.map(async (s: { id: string }) => {
        const [{ count, error: countErr }, { data: latest, error: latestErr }] =
          await Promise.all([
            supabaseAdmin
              .from('survey_responses')
              .select('*', { count: 'exact', head: true })
              .eq('survey_id', s.id),
            supabaseAdmin
              .from('survey_responses')
              .select('submitted_at')
              .eq('survey_id', s.id)
              .order('submitted_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);

        if (countErr) console.error('Survey count error:', s.id, countErr.message);
        if (latestErr) console.error('Survey latest response error:', s.id, latestErr.message);

        return [
          s.id,
          {
            count: count ?? 0,
            lastResponseAt: (latest as { submitted_at?: string } | null)?.submitted_at ?? null,
          },
        ] as const;
      })
    );

    const stats = Object.fromEntries(statsEntries) as Record<
      string,
      { count: number; lastResponseAt: string | null }
    >;

    res.json({
      surveys: list.map((s: { id: string }) => {
        const meta = stats[s.id] || { count: 0, lastResponseAt: null };
        return {
          ...s,
          response_count: meta.count,
          responseCount: meta.count,
          last_response_at: meta.lastResponseAt,
          lastResponseAt: meta.lastResponseAt,
        };
      }),
    });
  } catch (error: any) {
    console.error('List surveys error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/surveys/:id ────────────────────────────────────────────
// Fetch single survey details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: survey, error } = await supabaseAdmin
      .from('surveys')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    res.json(survey);
  } catch (error: any) {
    console.error('Fetch survey error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/surveys ───────────────────────────────────────────────
// Create new survey template (Admin only)
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, questions = [], targetRole = 'BOTH', isActive = true } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Survey title is required' });
    }

    const { data: newSurvey, error } = await supabaseAdmin
      .from('surveys')
      .insert({
        title,
        description,
        questions,
        target_role: targetRole,
        is_active: isActive,
        created_by: req.user!.id
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newSurvey);
  } catch (error: any) {
    console.error('Create survey error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/surveys/:id ────────────────────────────────────────────
// Update survey template (Admin only)
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('surveys')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.questions !== undefined) dbUpdates.questions = updates.questions;
    if (updates.targetRole !== undefined) dbUpdates.target_role = updates.targetRole;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;

    const { data: updated, error } = await supabaseAdmin
      .from('surveys')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update survey error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/surveys/:id ─────────────────────────────────────────
// Delete survey template (Admin only)
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('surveys')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    const { error } = await supabaseAdmin
      .from('surveys')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Survey template deleted successfully' });
  } catch (error: any) {
    console.error('Delete survey error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/surveys/:id/responses ─────────────────────────────────
// Submit answers to a survey
router.post('/:id/responses', async (req: AuthRequest, res: Response) => {
  try {
    const { id: surveyId } = req.params;
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const { answers = [] } = req.body;

    // Verify survey exists and is active
    const { data: survey, error: fetchErr } = await supabaseAdmin
      .from('surveys')
      .select('*')
      .eq('id', surveyId)
      .maybeSingle();

    if (fetchErr || !survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    if (!survey.is_active) {
      return res.status(400).json({ error: 'This survey is no longer accepting responses' });
    }

    // Verify role targeting
    if (survey.target_role !== 'BOTH' && survey.target_role !== userRole) {
      return res.status(403).json({ error: 'You are not eligible to take this survey' });
    }

    // Insert response (Supabase UNIQUE constraint handles duplicate protection)
    const { data: responseData, error } = await supabaseAdmin
      .from('survey_responses')
      .insert({
        survey_id: surveyId,
        user_id: userId,
        answers
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'You have already submitted a response for this survey' });
      }
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(responseData);
  } catch (error: any) {
    console.error('Submit response error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/surveys/:id/responses ──────────────────────────────────
// List all individual response logs (Admin & Mentor Manager only)
router.get('/:id/responses', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { id: surveyId } = req.params;

    const { data: responses, error } = await supabaseAdmin
      .from('survey_responses')
      .select('*, user:users(id, name, email, role)')
      .eq('survey_id', surveyId)
      .order('submitted_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ responses: responses || [] });
  } catch (error: any) {
    console.error('List responses error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/surveys/:id/analytics ──────────────────────────────────
// Fetch aggregate analytics for a survey (Admin & Mentor Manager only)
router.get('/:id/analytics', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { id: surveyId } = req.params;

    // Fetch survey template to read questions list
    const { data: survey, error: fetchErr } = await supabaseAdmin
      .from('surveys')
      .select('*')
      .eq('id', surveyId)
      .maybeSingle();

    if (fetchErr || !survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    // Fetch all responses
    const { data: responses, error: rErr } = await supabaseAdmin
      .from('survey_responses')
      .select('answers')
      .eq('survey_id', surveyId);

    if (rErr) {
      return res.status(500).json({ error: rErr.message });
    }

    const totalResponses = responses ? responses.length : 0;
    const questionsAnalytics: any[] = [];

    // Loop through each question in survey to compile aggregate stats
    const questionsList = (survey.questions || []) as any[];

    for (const question of questionsList) {
      const qId = question.id;
      const qType = question.type;
      const questionText = question.questionText || question.question || 'Question';

      const qAnswers = responses
        ? responses
            .map(r => {
              const answers = r.answers;
              if (Array.isArray(answers)) {
                return answers.find((a: any) => a.questionId === qId);
              }
              if (answers && typeof answers === 'object') {
                const val = (answers as Record<string, unknown>)[qId];
                return val !== undefined && val !== null && val !== ''
                  ? { questionId: qId, answerText: String(val) }
                  : undefined;
              }
              return undefined;
            })
            .filter(a => a !== undefined && a.answerText !== '')
        : [];

      if (qType === 'RATING') {
        const numericAnswers = qAnswers.map(a => Number(a.answerText)).filter(n => !isNaN(n));
        const sum = numericAnswers.reduce((acc, curr) => acc + curr, 0);
        const average = numericAnswers.length > 0 ? Number((sum / numericAnswers.length).toFixed(2)) : 0;

        // Frequencies for ratings 1-5
        const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        numericAnswers.forEach(n => {
          if (n >= 1 && n <= 5) {
            distribution[n] = (distribution[n] || 0) + 1;
          }
        });

        questionsAnalytics.push({
          questionId: qId,
          questionText,
          type: qType,
          totalCount: numericAnswers.length,
          stats: {
            average,
            distribution
          }
        });
      } else if (qType === 'MULTIPLE_CHOICE') {
        const optionCounts: Record<string, number> = {};
        const allowedOptions = question.options || [];

        allowedOptions.forEach((opt: string) => {
          optionCounts[opt] = 0;
        });

        qAnswers.forEach(a => {
          const ansText = a.answerText;
          optionCounts[ansText] = (optionCounts[ansText] || 0) + 1;
        });

        const breakdown = Object.entries(optionCounts).map(([option, count]) => {
          const percentage = qAnswers.length > 0 ? Number(((count / qAnswers.length) * 100).toFixed(1)) : 0;
          return { option, count, percentage };
        });

        questionsAnalytics.push({
          questionId: qId,
          questionText,
          type: qType,
          totalCount: qAnswers.length,
          stats: {
            breakdown
          }
        });
      } else {
        // TEXT question: compile lists
        const textAnswers = qAnswers.map(a => a.answerText);
        questionsAnalytics.push({
          questionId: qId,
          questionText,
          type: qType,
          totalCount: qAnswers.length,
          stats: {
            recentSubmissions: textAnswers.slice(0, 50) // Return last 50 text submissions
          }
        });
      }
    }

    res.json({
      surveyId,
      title: survey.title,
      totalResponses,
      questions: questionsAnalytics
    });
  } catch (error: any) {
    console.error('Get survey analytics error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const surveysRouter = router;
