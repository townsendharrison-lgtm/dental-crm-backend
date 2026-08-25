import { Router, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import {
  fetchUrlContent,
  extractSchoolCriteriaWithGemini,
  saveIngestionResults,
} from '../services/schoolIntelligenceService.js';
import {
  evaluateStudentForSchool,
  StudentProfileForPrediction,
} from '../services/predictiveModelService.js';
import {
  syncCrmStudentsToHistorical,
  batchUploadHistorical,
  calibrateSchoolRubrics,
} from '../services/outcomeCalibrationService.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// All routes require authentication
router.use(authenticate);

// ─── POST /api/school-intelligence/crawl ─────────────────────────────
// Crawl and extract admissions criteria & citations from a dental school URL
router.post('/crawl', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { url, schoolName, schoolId } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Valid URL is required.' });
    }

    const scrapedText = await fetchUrlContent(url);
    if (!scrapedText || scrapedText.length < 50) {
      return res.status(400).json({ error: 'Could not extract readable text from the provided URL.' });
    }

    const parsed = await extractSchoolCriteriaWithGemini(
      { text: scrapedText },
      {
        schoolName,
        sourceName: url,
        sourceType: 'URL',
        sourceUrl: url,
      }
    );

    const saved = await saveIngestionResults(schoolId || null, parsed, {
      sourceType: 'URL',
      sourceName: url,
      sourceUrl: url,
      userId: req.user!.id,
    });

    res.json(saved);
  } catch (error: any) {
    console.error('Crawl & extract error:', error);
    res.status(500).json({ error: error.message || 'Failed to crawl and extract URL.' });
  }
});

// ─── POST /api/school-intelligence/ingest-file ───────────────────────
// Ingest PDF, TXT, or Image (PNG/JPG) using Gemini Multimodal Vision & OCR
router.post(
  '/ingest-file',
  authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'),
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file;
      const { schoolName, schoolId } = req.body;

      if (!file) {
        return res.status(400).json({ error: 'File upload is required.' });
      }

      const mimeType = file.mimetype;
      const originalName = file.originalname || 'uploaded_document';
      let contentPayload: { text?: string; imageBase64?: string; mimeType?: string } = {};
      let sourceType: 'PDF' | 'TXT' | 'IMAGE' = 'TXT';

      if (mimeType.startsWith('image/')) {
        sourceType = 'IMAGE';
        contentPayload = {
          imageBase64: file.buffer.toString('base64'),
          mimeType,
        };
      } else if (mimeType === 'application/pdf') {
        sourceType = 'PDF';
        // Convert PDF buffer to base64 for multimodal extraction
        contentPayload = {
          imageBase64: file.buffer.toString('base64'),
          mimeType: 'application/pdf',
        };
      } else {
        // Plain text / Markdown
        sourceType = 'TXT';
        contentPayload = {
          text: file.buffer.toString('utf-8'),
        };
      }

      const parsed = await extractSchoolCriteriaWithGemini(contentPayload, {
        schoolName,
        sourceName: originalName,
        sourceType,
      });

      const saved = await saveIngestionResults(schoolId || null, parsed, {
        sourceType,
        sourceName: originalName,
        userId: req.user!.id,
      });

      res.json(saved);
    } catch (error: any) {
      console.error('File ingest error:', error);
      res.status(500).json({ error: error.message || 'Failed to process and extract file.' });
    }
  }
);

// ─── POST /api/school-intelligence/ingest-text ───────────────────────
// Ingest manual text or notes
router.post('/ingest-text', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { text, schoolName, schoolId, sourceName = 'Manual Notes' } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text content is required.' });
    }

    const parsed = await extractSchoolCriteriaWithGemini(
      { text },
      {
        schoolName,
        sourceName,
        sourceType: 'MANUAL',
      }
    );

    const saved = await saveIngestionResults(schoolId || null, parsed, {
      sourceType: 'MANUAL',
      sourceName,
      userId: req.user!.id,
    });

    res.json(saved);
  } catch (error: any) {
    console.error('Text ingest error:', error);
    res.status(500).json({ error: error.message || 'Failed to process manual text.' });
  }
});

// ─── GET /api/school-intelligence/evidence/:schoolId ─────────────────
// Get all evidence citations for a school
router.get('/evidence/:schoolId', async (req: AuthRequest, res: Response) => {
  try {
    const { schoolId } = req.params;
    const { data: evidence, error } = await supabaseAdmin
      .from('school_evidence')
      .select('*, verified_user:users!verified_by(name, email)')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ evidence: evidence || [] });
  } catch (error: any) {
    console.error('Fetch evidence error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/school-intelligence/evidence/:id/verify ────────────────
// Toggle or set verification status on an evidence citation snippet
router.put('/evidence/:id/verify', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { isVerified = true, notes } = req.body;

    const { data: updated, error } = await supabaseAdmin
      .from('school_evidence')
      .update({
        is_verified: isVerified,
        verified_by: isVerified ? req.user!.id : null,
        verified_at: isVerified ? new Date().toISOString() : null,
        notes: notes !== undefined ? notes : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, verified_user:users!verified_by(name, email)')
      .single();

    if (error) throw error;
    res.json(updated);
  } catch (error: any) {
    console.error('Verify evidence error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/school-intelligence/evidence/:id ─────────────────────
// Delete an evidence item
router.delete('/evidence/:id', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('school_evidence').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Evidence snippet removed.' });
  } catch (error: any) {
    console.error('Delete evidence error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/school-intelligence/rubrics/:schoolId ───────────────────
// Fetch scoring rubric and weights for a school
router.get('/rubrics/:schoolId', async (req: AuthRequest, res: Response) => {
  try {
    const { schoolId } = req.params;
    const { data: rubric, error } = await supabaseAdmin
      .from('school_scoring_rubrics')
      .select('*')
      .eq('school_id', schoolId)
      .maybeSingle();

    if (error) throw error;
    res.json(rubric || null);
  } catch (error: any) {
    console.error('Fetch rubric error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/school-intelligence/rubrics/:schoolId ───────────────────
// Update scoring rubric and weights for a school
router.put('/rubrics/:schoolId', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { schoolId } = req.params;
    const { weights, cutoffs, prerequisites, holisticFactors, notes } = req.body;

    const { data: updated, error } = await supabaseAdmin
      .from('school_scoring_rubrics')
      .upsert({
        school_id: schoolId,
        weights: weights || undefined,
        cutoffs: cutoffs || undefined,
        prerequisites: prerequisites || undefined,
        holistic_factors: holisticFactors || undefined,
        calibration_notes: notes || undefined,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'school_id' })
      .select()
      .single();

    if (error) throw error;
    res.json(updated);
  } catch (error: any) {
    console.error('Update rubric error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/school-intelligence/historical-applications ────────────
// List historical student applications dataset
router.get('/historical-applications', authorize('ADMIN', 'MENTOR_MANAGER', 'MENTOR'), async (req: AuthRequest, res: Response) => {
  try {
    const { schoolId, cycle, outcome } = req.query;
    let query = supabaseAdmin
      .from('historical_applications')
      .select('*')
      .order('created_at', { ascending: false });

    if (schoolId) query = query.eq('school_id', schoolId as string);
    if (cycle) query = query.eq('cycle', cycle as string);
    if (outcome) query = query.eq('outcome', outcome as string);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ applications: data || [] });
  } catch (error: any) {
    console.error('Fetch historical applications error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/school-intelligence/historical-applications/sync ──────
// Synchronize CRM student outcomes into historical applications table
router.post('/historical-applications/sync', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await syncCrmStudentsToHistorical();
    res.json(result);
  } catch (error: any) {
    console.error('Sync historical applications error:', error);
    res.status(500).json({ error: error.message || 'Failed to sync CRM students.' });
  }
});

// ─── POST /api/school-intelligence/historical-applications/upload ────
// Batch upload historical student cases (CSV / JSON)
router.post('/historical-applications/upload', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array of application records.' });
    }
    const result = await batchUploadHistorical(items);
    res.json(result);
  } catch (error: any) {
    console.error('Upload historical applications error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload historical applications.' });
  }
});

// ─── POST /api/school-intelligence/calibrate ─────────────────────────
// Calibrate school scoring rubrics from historical application outcomes
router.post('/calibrate', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { schoolId } = req.body;
    const result = await calibrateSchoolRubrics(schoolId);
    res.json(result);
  } catch (error: any) {
    console.error('Calibrate rubrics error:', error);
    res.status(500).json({ error: error.message || 'Failed to calibrate school rubrics.' });
  }
});

// ─── POST /api/school-intelligence/predict ───────────────────────────
// Run predictive model for a student (or simulator profile)
router.post('/predict', async (req: AuthRequest, res: Response) => {
  try {
    const { studentProfile, schoolId } = req.body;
    if (!studentProfile) {
      return res.status(400).json({ error: 'studentProfile is required.' });
    }

    let schoolsQuery = supabaseAdmin.from('schools').select('*');
    if (schoolId) {
      schoolsQuery = schoolsQuery.eq('id', schoolId);
    }
    const { data: schools, error: sErr } = await schoolsQuery;
    if (sErr || !schools || schools.length === 0) {
      return res.status(404).json({ error: 'School not found.' });
    }

    const { data: rubrics } = await supabaseAdmin
      .from('school_scoring_rubrics')
      .select('*')
      .in('school_id', schools.map((s) => s.id));

    const rubricMap = new Map<string, any>();
    (rubrics || []).forEach((r) => rubricMap.set(r.school_id, r));

    const predictions = schools.map((s) =>
      evaluateStudentForSchool(studentProfile, s, rubricMap.get(s.id))
    );

    res.json({ predictions });
  } catch (error: any) {
    console.error('Predict error:', error);
    res.status(500).json({ error: error.message || 'Failed to run prediction.' });
  }
});

// ─── GET /api/school-intelligence/student-fit/:studentId ─────────────
// Get full fit evaluation and predictive probabilities for an active student
router.get('/student-fit/:studentId', async (req: AuthRequest, res: Response) => {
  try {
    const { studentId } = req.params;
    const userId = req.user!.id;
    const role = req.user!.role;

    // Access check: Student can view own, mentors can view assigned, admins see all
    if (role === 'STUDENT' && studentId !== userId) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // 1. Fetch student profile & experiences
    const { data: profile, error: pErr } = await supabaseAdmin
      .from('student_profiles')
      .select('*, user:users(name, email)')
      .eq('id', studentId)
      .maybeSingle();

    if (pErr || !profile) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }

    const { data: experiences } = await supabaseAdmin
      .from('experiences')
      .select('category, total_hours')
      .eq('student_id', studentId);

    let shadowing = 0;
    let volunteering = 0;
    let dental = 0;
    let research = 0;

    (experiences || []).forEach((exp) => {
      const cat = (exp.category || '').toLowerCase();
      const hrs = Number(exp.total_hours || 0);
      if (cat.includes('shadow')) shadowing += hrs;
      else if (cat.includes('volunteer') || cat.includes('community')) volunteering += hrs;
      else if (cat.includes('dental') || cat.includes('assistant') || cat.includes('hygien')) dental += hrs;
      else if (cat.includes('research')) research += hrs;
    });

    const studentData: StudentProfileForPrediction = {
      id: profile.id,
      name: (profile as any).user?.name || 'Student',
      cgpa: profile.gpa,
      sgpa: profile.sgpa,
      datAa: profile.dat_aa || profile.dat_score,
      datTs: profile.dat_ts || profile.dat_aa || profile.dat_score,
      datPat: profile.dat_pat,
      shadowingHours: shadowing,
      volunteeringHours: volunteering,
      dentalExperienceHours: dental,
      researchHours: research,
      lorCount: profile.lor_required || 3,
      state: profile.state,
      isReapplicant: profile.is_reapplicant,
      tookCcClasses: profile.took_cc_classes,
      isCanadianDat: profile.dat_type === 'CANADIAN',
    };

    // 2. Fetch all schools and rubrics
    const { data: schools } = await supabaseAdmin
      .from('schools')
      .select('*')
      .order('name', { ascending: true });

    const { data: rubrics } = await supabaseAdmin
      .from('school_scoring_rubrics')
      .select('*');

    const rubricMap = new Map<string, any>();
    (rubrics || []).forEach((r) => rubricMap.set(r.school_id, r));

    const predictions = (schools || []).map((s) =>
      evaluateStudentForSchool(studentData, s, rubricMap.get(s.id))
    );

    // Sort predictions: highest matchScore first
    predictions.sort((a, b) => b.matchScore - a.matchScore);

    res.json({
      student: studentData,
      predictions,
    });
  } catch (error: any) {
    console.error('Student fit error:', error);
    res.status(500).json({ error: error.message || 'Failed to calculate student fit.' });
  }
});

export const schoolIntelligenceRouter = router;
