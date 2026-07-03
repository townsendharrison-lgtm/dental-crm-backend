import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import multer from 'multer';

const router = Router();

// Multer config: memory storage for Supabase upload, max 10MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
      'image/jpg'
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, Word Documents, and Images (PNG/JPG) are accepted.'));
    }
  }
});

// All routes require authentication
router.use(authenticate);

// ─── POST /api/documents/upload ──────────────────────────────────────
// Upload a student document to Supabase Storage + Save metadata
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const file = req.file;
    const { studentId, title, type } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'File is required' });
    }

    if (!title || !type) {
      return res.status(400).json({ error: 'Title and document type are required' });
    }

    // Determine target student ID (Student defaults to self, staff specifies studentId)
    const targetStudentId = role === 'STUDENT' ? userId : studentId;

    if (!targetStudentId) {
      return res.status(400).json({ error: 'Student ID is required' });
    }

    // Authorization checks: Mentors can only upload for their assigned students
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', targetStudentId)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'You can only upload documents for assigned students' });
      }
    }

    // Get student details (for notification)
    const { data: studentUser } = await supabaseAdmin
      .from('users')
      .select('name')
      .eq('id', targetStudentId)
      .single();
    const studentName = studentUser?.name || 'A Student';

    // 1. Upload to Supabase Storage Bucket `student-documents`
    const fileExtension = file.originalname.split('.').pop();
    const filePath = `documents/${targetStudentId}/${Date.now()}_${uuidSecure()}.${fileExtension}`;

    const { error: uploadError } = await supabaseAdmin
      .storage
      .from('student-documents')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (uploadError) {
      console.error('Supabase Storage upload error:', uploadError.message);
      return res.status(500).json({ error: 'Storage upload failed: ' + uploadError.message });
    }

    // 2. Save metadata to database `student_documents`
    const { data: document, error: dbError } = await supabaseAdmin
      .from('student_documents')
      .insert({
        student_id: targetStudentId,
        title,
        type,
        url: filePath,
        status: 'Pending Review'
      })
      .select()
      .single();

    if (dbError) {
      // Clean up the storage file if db insert fails
      await supabaseAdmin.storage.from('student-documents').remove([filePath]);
      return res.status(500).json({ error: dbError.message });
    }

    // 3. Trigger notification to mentor (if student uploaded it)
    if (role === 'STUDENT') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', userId)
        .maybeSingle();

      const mentorId = profile?.mentor_id;
      if (mentorId) {
        // Insert notification for mentor
        await supabaseAdmin.from('notifications').insert({
          user_id: mentorId,
          title: '📄 New Document Uploaded',
          message: `${studentName} uploaded a new ${type}: "${title}".`,
          type: 'INFO',
          category: 'DOCUMENT_UPLOADED',
          related_id: document.id,
          created_by: userId
        });
      }
    }

    res.status(201).json(document);
  } catch (error: any) {
    console.error('Upload document error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/documents ──────────────────────────────────────────────
// List student documents metadata (filters by role)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.query;

    let query = supabaseAdmin
      .from('student_documents')
      .select('*')
      .order('uploaded_at', { ascending: false });

    if (role === 'STUDENT') {
      query = query.eq('student_id', userId);
    } else if (role === 'MENTOR') {
      if (studentId) {
        // Verify mentor is assigned to studentId
        const { data: profile } = await supabaseAdmin
          .from('student_profiles')
          .select('mentor_id')
          .eq('id', studentId as string)
          .maybeSingle();

        if (!profile || profile.mentor_id !== userId) {
          return res.status(403).json({ error: 'You are not assigned to this student' });
        }
        query = query.eq('student_id', studentId as string);
      } else {
        // Query documents of all assigned students
        const { data: assignedStudents } = await supabaseAdmin
          .from('student_profiles')
          .select('id')
          .eq('mentor_id', userId);

        const studentIds = assignedStudents ? assignedStudents.map(s => s.id) : [];
        query = query.in('student_id', studentIds);
      }
    } else {
      // Admin / Mentor Manager
      if (studentId) {
        query = query.eq('student_id', studentId as string);
      }
    }

    const { data: documents, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ documents: documents || [] });
  } catch (error: any) {
    console.error('List documents error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/documents/:id ──────────────────────────────────────────
// Fetch document details + Generate temporary secure Signed URL
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: document, error } = await supabaseAdmin
      .from('student_documents')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Access authorization checks
    const isOwner = document.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', document.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Generate a temporary Signed URL for the document (valid for 1 hour)
    const { data: signedUrlData, error: signedError } = await supabaseAdmin
      .storage
      .from('student-documents')
      .createSignedUrl(document.url, 3600); // 1 hour expiration

    if (signedError) {
      console.error('Failed to create signed storage URL:', signedError.message);
    }

    res.json({
      ...document,
      downloadUrl: signedUrlData?.signedUrl || null
    });
  } catch (error: any) {
    console.error('Fetch document details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/documents/:id ──────────────────────────────────────────
// Update document metadata (status, comment, title)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('student_documents')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Authorization checks
    const isOwner = existing.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', existing.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };

    // Students can only update title
    if (isOwner) {
      if (updates.title !== undefined) dbUpdates.title = updates.title;
    }

    // Mentors, Managers, and Admins can update status, comments, private notes
    if (isAssignedMentor || isPrivileged) {
      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.comment !== undefined) dbUpdates.comment = updates.comment;
      if (updates.private_note !== undefined) dbUpdates.private_note = updates.private_note;
      // Admins can edit title too
      if (isPrivileged && updates.title !== undefined) dbUpdates.title = updates.title;
    }

    const { data: updated, error } = await supabaseAdmin
      .from('student_documents')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Trigger notification to student if status was updated by mentor/admin
    if (updates.status && updates.status !== existing.status && !isOwner) {
      const statusSymbol = updates.status === 'Reviewed' ? '✅' : '⚠️';
      await supabaseAdmin.from('notifications').insert({
        user_id: existing.student_id,
        title: `${statusSymbol} Document Reviewed`,
        message: `Your ${existing.type} "${existing.title}" status has been updated to "${updates.status}".`,
        type: updates.status === 'Needs Revision' ? 'WARNING' : 'INFO',
        category: 'DOCUMENT_REVIEWED',
        related_id: id,
        created_by: userId
      });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update document error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/documents/:id ───────────────────────────────────────
// Delete document metadata from database + Remove physical file from bucket
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: document, error: fetchErr } = await supabaseAdmin
      .from('student_documents')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Delete permission: Only the student owner or Admin can delete documents
    const isOwner = document.student_id === userId;
    const isAdmin = role === 'ADMIN';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You do not have permission to delete this document' });
    }

    // 1. Delete physical file from Supabase Storage bucket `student-documents`
    const { error: storageError } = await supabaseAdmin
      .storage
      .from('student-documents')
      .remove([document.url]);

    if (storageError) {
      console.warn(`Failed to delete storage file at ${document.url} (continuing delete anyway):`, storageError.message);
    }

    // 2. Delete database row
    const { error: dbError } = await supabaseAdmin
      .from('student_documents')
      .delete()
      .eq('id', id);

    if (dbError) {
      return res.status(500).json({ error: dbError.message });
    }

    res.json({ message: 'Document and file deleted successfully' });
  } catch (error: any) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Helper UUID Generator for file name mapping
function uuidSecure(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export const documentsRouter = router;
