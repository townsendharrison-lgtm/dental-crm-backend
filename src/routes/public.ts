import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { supabaseAdmin } from '../config/supabase.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Public endpoint for letter upload (no authentication required)
// This is for the Letter Writer feature - free access
router.post('/letter-upload', async (req: Request, res: Response) => {
  try {
    const { studentName, dentalSchool, letterContent, writerName, writerEmail } = req.body;

    // Validate required fields
    if (!studentName || !dentalSchool || !letterContent || !writerName || !writerEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Insert letter into database
    const { data: letter, error } = await supabase
      .from('letters')
      .insert({
        id: uuidv4(),
        student_name: studentName,
        dental_school: dentalSchool,
        letter_content: letterContent,
        writer_name: writerName,
        writer_email: writerEmail,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({
      message: 'Letter uploaded successfully',
      letter
    });
  } catch (error) {
    console.error('Letter upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get letter by ID (public access)
router.get('/letter/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data: letter, error } = await supabase
      .from('letters')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !letter) {
      return res.status(404).json({ error: 'Letter not found' });
    }

    res.json(letter);
  } catch (error) {
    console.error('Get letter error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/public/student-profile/:token — read-only shared student snapshot
router.get('/student-profile/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const { data: share, error } = await supabaseAdmin
      .from('student_profile_shares')
      .select('*')
      .eq('token', token)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !share) {
      return res.status(404).json({ error: 'Share link not found or revoked' });
    }

    const { loadStudentPublicSnapshot } = await import('../services/studentProfileShare.js');
    const snapshot = await loadStudentPublicSnapshot(share.student_id);

    // Public viewers get a sanitized payload (no private mentor notes)
    res.json({
      sharedAt: share.created_at,
      readOnly: true,
      ...snapshot,
    });
  } catch (error: any) {
    console.error('Public student profile error:', error);
    const status = error?.status || 500;
    res.status(status).json({ error: error.message || 'Internal server error' });
  }
});

export { router as publicRouter };
