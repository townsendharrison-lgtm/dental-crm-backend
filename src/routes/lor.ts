import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { messaging } from '../config/firebase.js';
import { sendInitialEmail, sendDeclineReuploadEmail, sendTestEmail } from '../services/lorEmailService.js';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const router = Router();

// Multer config — store in memory buffer for Supabase upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  },
});

function generateAccessCode(studentName: string, writerName: string): string {
  const s = studentName.substring(0, 2).toUpperCase().replace(/[^A-Z]/g, 'X').padEnd(2, 'X');
  const w = writerName.substring(0, 2).toUpperCase().replace(/[^A-Z]/g, 'X').padEnd(2, 'X');
  const rand1 = Math.random().toString(36).substring(2, 6).toUpperCase().padStart(4, '0');
  const rand2 = Math.random().toString(36).substring(2, 6).toUpperCase().padStart(4, '0');
  return `LOR-${s}${w}-${rand1}-${rand2}`;
}

// ─── Tracking Token Utils ────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.JWT_SECRET || 'fallback_secret_key_needs_32_bytes_length!'.substring(0, 32);
const IV_LENGTH = 16;

function encryptTrackingToken(email: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').substring(0, 32));
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(email);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptTrackingToken(token: string): string | null {
  try {
    const textParts = token.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').substring(0, 32));
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (err) {
    return null;
  }
}

// ─── Helper: send push notification to admins ────────────────────
async function notifyAdminsLORUploaded(writerName: string, studentName: string, requestId: string) {
  try {
    const { data: admins } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('role', 'ADMIN');

    if (!admins || admins.length === 0) return;

    // In-app notifications
    const rows = admins.map((admin: { id: string }) => ({
      user_id: admin.id,
      title: '📄 New Letter Uploaded',
      message: `${writerName} uploaded a letter of recommendation for ${studentName}. Review it now.`,
      type: 'URGENT' as const,
      category: 'LOR_UPLOADED',
      related_id: requestId,
      is_read: false,
      created_by: 'system',
    }));

    await supabaseAdmin.from('notifications').insert(rows);

    // FCM push
    if (messaging) {
      const adminIds = admins.map((a: { id: string }) => a.id);
      const { data: tokens } = await supabaseAdmin
        .from('fcm_tokens')
        .select('token')
        .in('user_id', adminIds);

      if (tokens && tokens.length > 0) {
        const tokenStrings = tokens.map((t: { token: string }) => t.token);
        try {
          const response = await messaging.sendEachForMulticast({
            tokens: tokenStrings,
            notification: {
              title: `📄 New Letter Uploaded`,
              body: `${writerName} submitted a letter for ${studentName}. Tap to review.`,
            },
            webpush: {
              fcmOptions: { link: process.env.FRONTEND_URL || 'http://localhost:3000' },
              notification: {
                icon: 'https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng',
                badge: 'https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng',
              },
            },
            data: { type: 'LOR_UPLOADED', requestId },
          });
          console.log(`🔔 LOR upload push: ${response.successCount} success, ${response.failureCount} failed`);
        } catch (fcmErr) {
          console.error('FCM LOR upload push error:', fcmErr);
        }
      }
    }
  } catch (err) {
    console.error('Error notifying admins of LOR upload:', err);
  }
}

// ─── Helper: send push notification to student ──────────────────
async function notifyStudentLORReviewed(studentId: string, writerName: string, status: string) {
  if (!studentId) return; // Guest students don't get push notifications
  try {
    const statusText = status === 'REVIEWED' ? 'approved' : 'declined';
    const notifRow = {
      user_id: studentId,
      title: status === 'REVIEWED' ? '✅ Letter Approved' : '⚠️ Letter Needs Revision',
      message: status === 'REVIEWED'
        ? `The letter from ${writerName} has been reviewed and approved!`
        : `The letter from ${writerName} has been declined. The writer has been notified to re-submit.`,
      type: status === 'REVIEWED' ? 'INFO' as const : 'WARNING' as const,
      category: 'LOR_REVIEWED',
      is_read: false,
      created_by: 'admin',
    };

    await supabaseAdmin.from('notifications').insert(notifRow);

    // FCM push
    if (messaging) {
      const { data: tokens } = await supabaseAdmin
        .from('fcm_tokens')
        .select('token')
        .eq('user_id', studentId);

      if (tokens && tokens.length > 0) {
        const tokenStrings = tokens.map((t: { token: string }) => t.token);
        try {
          await messaging.sendEachForMulticast({
            tokens: tokenStrings,
            notification: {
              title: notifRow.title,
              body: notifRow.message,
            },
            webpush: {
              fcmOptions: { link: process.env.FRONTEND_URL || 'http://localhost:3000' },
              notification: {
                icon: 'https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng',
              },
            },
            data: { type: 'LOR_REVIEWED', status },
          });
        } catch (fcmErr) {
          console.error('FCM LOR reviewed push error:', fcmErr);
        }
      }
    }
  } catch (err) {
    console.error('Error notifying student of LOR review:', err);
  }
}

// ─── Helper: get email config ──────────────────────────────────
async function getEmailConfig() {
  const { data } = await supabaseAdmin
    .from('lor_email_config')
    .select('*')
    .limit(1)
    .single();
  return data;
}


// ════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES (no auth required)
// ════════════════════════════════════════════════════════════════

// ─── POST /api/lor/requests/guest — Guest creates LOR request ──
router.post('/requests/guest', async (req: Request, res: Response) => {
  try {
    const { studentName, studentEmail, writerName, writerEmail, dueDate } = req.body;

    if (!studentName || !studentEmail || !writerName || !writerEmail || !dueDate) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const accessCode = generateAccessCode(studentName, writerName);

    const { data: lorReq, error } = await supabaseAdmin
      .from('lor_requests')
      .insert({
        student_name: studentName,
        student_email: studentEmail,
        writer_name: writerName,
        writer_email: writerEmail,
        due_date: dueDate,
        access_code: accessCode,
        status: 'REQUESTED',
      })
      .select()
      .single();

    if (error) {
      console.error('Guest LOR request insert error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    // Send initial email
    const config = await getEmailConfig();
    if (config) {
      const sent = await sendInitialEmail(lorReq, config);
      if (sent) {
        await supabaseAdmin.from('lor_email_log').insert({
          lor_request_id: lorReq.id,
          email_type: 'INITIAL',
          recipient_email: writerEmail,
        });
      }
    }

    // Send tracking email to STUDENT
    try {
      const trackingToken = encryptTrackingToken(studentEmail.toLowerCase().trim());
      const trackingUrl = `${process.env.LOR_GUEST_TRACK_URL || process.env.FRONTEND_URL || 'http://localhost:3000'}/#/guest-letter-track?token=${encodeURIComponent(trackingToken)}`;
      
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.LOR_FROM_EMAIL || 'Dental School Guide <no-reply@dentalschoolguide.com>',
        to: studentEmail,
        subject: 'Track Your Letter of Recommendation',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 40px; border-radius: 16px;">
            <h2 style="color: #fff; margin-top: 0;">Track Your Letter Request</h2>
            <p style="color: #cbd5e1; font-size: 16px; line-height: 1.6;">
              Hi ${studentName},<br><br>
              Your letter of recommendation request to <strong>${writerName}</strong> has been sent successfully!
            </p>
            <p style="color: #cbd5e1; font-size: 16px; line-height: 1.6;">
              You can track the status of this request (and any others you submit) at any time using your secure tracking link below.
            </p>
            <div style="margin: 32px 0;">
              <a href="${trackingUrl}" style="background-color: #4f46e5; color: #ffffff; padding: 16px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Track My Letter Status
              </a>
            </div>
            <p style="color: #64748b; font-size: 14px;">
              Please save this email. This link is unique to you and securely tied to your email address.
            </p>
          </div>
        `
      });
    } catch (emailErr) {
      console.error('Failed to send tracking email to student:', emailErr);
    }

    res.status(201).json({
      request: lorReq,
      trackingUrl: `${process.env.LOR_GUEST_TRACK_URL || process.env.FRONTEND_URL || 'http://localhost:3000'}/#/guest-letter-track?token=${encodeURIComponent(encryptTrackingToken(studentEmail.toLowerCase().trim()))}`,
    });
  } catch (err) {
    console.error('Guest LOR request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/lor/requests/track — Guest tracks by secure token ──
router.get('/requests/track', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;

    if (!token) {
      return res.status(401).json({ error: 'Tracking token is missing' });
    }

    const email = decryptTrackingToken(token);
    if (!email) {
      return res.status(401).json({ error: 'Invalid or expired tracking token' });
    }

    const { data, error } = await supabaseAdmin
      .from('lor_requests')
      .select('id, student_name, writer_name, writer_email, due_date, status, requested_at, uploaded_at, reviewed_at, decline_reason, access_code')
      .eq('student_email', email)
      .order('requested_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ requests: data || [] });
  } catch (err) {
    console.error('Guest LOR track error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/lor/requests/:id/tracking-link — Admin retrieves link ──
router.get('/requests/:id/tracking-link', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('lor_requests')
      .select('student_email')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const token = encryptTrackingToken(data.student_email.toLowerCase().trim());
    const trackingUrl = `${process.env.LOR_GUEST_TRACK_URL || process.env.FRONTEND_URL || 'http://localhost:3000'}/#/guest-letter-track?token=${encodeURIComponent(token)}`;

    res.json({ trackingUrl });
  } catch (err) {
    console.error('Get tracking link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/lor/upload/:accessCode — Verify access code ─────
router.get('/upload/:accessCode', async (req: Request, res: Response) => {
  try {
    const { accessCode } = req.params;

    const { data, error } = await supabaseAdmin
      .from('lor_requests')
      .select('id, student_name, writer_name, writer_email, due_date, status, access_code, decline_reason')
      .eq('access_code', accessCode)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Invalid Access Code. Please check your email and try again.' });
    }

    // Fetch email config for requirements display on the upload page
    const config = await getEmailConfig();
    const configInfo = config ? {
      requirements: config.content?.requirements || '',
      requirementsPdfUrl: config.content?.requirementsPdfUrl || '',
      exampleLetterPdfUrl: config.content?.exampleLetterPdfUrl || '',
      exampleLetter: config.content?.exampleLetter || '',
    } : null;

    res.json({ request: data, config: configInfo });
  } catch (err) {
    console.error('LOR verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/lor/upload/:accessCode — Upload letter PDF ─────
router.post('/upload/:accessCode', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { accessCode } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'PDF file is required' });
    }

    // Find the request
    const { data: lorReq, error: findError } = await supabaseAdmin
      .from('lor_requests')
      .select('*')
      .eq('access_code', accessCode)
      .single();

    if (findError || !lorReq) {
      return res.status(404).json({ error: 'Invalid access code' });
    }

    if (lorReq.status === 'REVIEWED') {
      return res.status(400).json({ error: 'This letter has already been reviewed and accepted' });
    }

    // Upload to Supabase Storage
    const filePath = `lor/${lorReq.id}/${Date.now()}_${file.originalname}`;

    const { error: uploadError } = await supabaseAdmin
      .storage
      .from('lor-documents')
      .upload(filePath, file.buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      console.error('Supabase storage upload error:', uploadError.message);
      return res.status(500).json({ error: 'Failed to upload file: ' + uploadError.message });
    }

    // Update the request
    const { error: updateError } = await supabaseAdmin
      .from('lor_requests')
      .update({
        status: 'UPLOADED',
        document_url: filePath,
        uploaded_at: new Date().toISOString(),
        reminders_stopped: true,
        decline_reason: null, // Clear any previous decline reason
      })
      .eq('id', lorReq.id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update request' });
    }

    // Notify admins
    await notifyAdminsLORUploaded(lorReq.writer_name, lorReq.student_name, lorReq.id);

    res.json({ success: true, message: 'Letter uploaded successfully' });
  } catch (err) {
    console.error('LOR upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ════════════════════════════════════════════════════════════════
//  AUTHENTICATED ROUTES
// ════════════════════════════════════════════════════════════════

// ─── GET /api/lor/requests — Admin/Student gets requests ──────────
router.get('/requests', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status as string;
    const search = req.query.search as string;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    let query = supabaseAdmin
      .from('lor_requests')
      .select('*')
      .order('requested_at', { ascending: false });

    // Students can only see their own requests
    if (userRole === 'STUDENT') {
      query = query.eq('student_id', userId);
    }

    if (status && status !== 'ALL') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    let requests = data || [];

    // Client-side search filter (Supabase doesn't have easy OR ilike across columns)
    if (search) {
      const s = search.toLowerCase();
      requests = requests.filter((r: any) =>
        r.student_name?.toLowerCase().includes(s) ||
        r.writer_name?.toLowerCase().includes(s) ||
        r.writer_email?.toLowerCase().includes(s) ||
        r.access_code?.toLowerCase().includes(s)
      );
    }

    res.json({ requests });
  } catch (err) {
    console.error('Get LOR requests error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/lor/requests — Student/Admin creates request ───
router.post('/requests', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { writerName, writerEmail, dueDate, studentName } = req.body;
    const userId = req.user!.id;

    if (!writerName || !writerEmail || !dueDate) {
      return res.status(400).json({ error: 'Writer name, email, and due date are required' });
    }

    // Get student name
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('name, email')
      .eq('id', userId)
      .single();

    const sName = studentName || userData?.name || 'Student';
    const sEmail = userData?.email || '';
    const accessCode = generateAccessCode(sName, writerName);

    const { data: lorReq, error } = await supabaseAdmin
      .from('lor_requests')
      .insert({
        student_id: userId,
        student_name: sName,
        student_email: sEmail,
        writer_name: writerName,
        writer_email: writerEmail,
        due_date: dueDate,
        access_code: accessCode,
        status: 'REQUESTED',
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Send initial email
    const config = await getEmailConfig();
    if (config) {
      const sent = await sendInitialEmail(lorReq, config);
      if (sent) {
        await supabaseAdmin.from('lor_email_log').insert({
          lor_request_id: lorReq.id,
          email_type: 'INITIAL',
          recipient_email: writerEmail,
        });
      }
    }

    res.status(201).json({ request: lorReq });
  } catch (err) {
    console.error('Create LOR request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/lor/requests/:id/status — Accept/Decline ──────
router.patch('/requests/:id/status', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, declineReason } = req.body;

    if (!['REVIEWED', 'DECLINED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be REVIEWED or DECLINED' });
    }

    const updates: any = { status };
    if (status === 'REVIEWED') {
      updates.reviewed_at = new Date().toISOString();
    }
    if (status === 'DECLINED') {
      updates.decline_reason = declineReason || 'No reason provided';
      // Reset to allow re-upload
      updates.document_url = null;
      updates.uploaded_at = null;
      updates.reminders_stopped = false;
    }

    const { data: updated, error } = await supabaseAdmin
      .from('lor_requests')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Send notifications
    if (status === 'DECLINED' && updated) {
      // Send re-upload email to writer
      const config = await getEmailConfig();
      if (config) {
        const sent = await sendDeclineReuploadEmail(updated, config, updates.decline_reason);
        if (sent) {
          await supabaseAdmin.from('lor_email_log').insert({
            lor_request_id: id,
            email_type: 'DECLINED_REUPLOAD',
            recipient_email: updated.writer_email,
          });
        }
      }
    }

    // Push notification to student
    if (updated?.student_id) {
      await notifyStudentLORReviewed(updated.student_id, updated.writer_name, status);
    }

    res.json({ request: updated });
  } catch (err) {
    console.error('Update LOR status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/lor/documents/:requestId — Signed URL ────────────
router.get('/documents/:requestId', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { requestId } = req.params;

    const { data: lorReq, error } = await supabaseAdmin
      .from('lor_requests')
      .select('document_url')
      .eq('id', requestId)
      .single();

    if (error || !lorReq?.document_url) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Create signed URL (valid for 1 hour)
    const { data: signedUrl, error: signError } = await supabaseAdmin
      .storage
      .from('lor-documents')
      .createSignedUrl(lorReq.document_url, 3600, { download: true });

    if (signError) {
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }

    res.json({ url: signedUrl.signedUrl });
  } catch (err) {
    console.error('Get LOR document error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/lor/config — Admin gets email config ────────────
router.get('/config', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const config = await getEmailConfig();
    if (!config) {
      return res.status(404).json({ error: 'No config found' });
    }
    res.json({ config });
  } catch (err) {
    console.error('Get LOR config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/lor/config — Admin saves email config ────────────
router.put('/config', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { design, content, reminderSchedule } = req.body;

    // Get existing config
    const existing = await getEmailConfig();

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('lor_email_config')
        .update({
          design: design || existing.design,
          content: content || existing.content,
          reminder_schedule: reminderSchedule || existing.reminder_schedule,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ config: data });
    } else {
      const { data, error } = await supabaseAdmin
        .from('lor_email_config')
        .insert({
          design: design || {},
          content: content || {},
          reminder_schedule: reminderSchedule || [-7, -3, 0, 3, 7],
        })
        .select()
        .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.status(201).json({ config: data });
    }
  } catch (err) {
    console.error('Save LOR config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/lor/send-test-email — Admin sends test ─────────
router.post('/send-test-email', authenticate, authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { testEmail } = req.body;
    const config = await getEmailConfig();

    if (!config) {
      return res.status(404).json({ error: 'No email config found. Save config first.' });
    }

    const toEmail = testEmail || req.user!.email;
    if (!toEmail) {
      return res.status(400).json({ error: 'No email address provided' });
    }

    const sent = await sendTestEmail(toEmail, config);

    if (sent) {
      res.json({ success: true, message: `Test email sent to ${toEmail}` });
    } else {
      res.status(500).json({ error: 'Failed to send test email. Check Resend API key configuration.' });
    }
  } catch (err) {
    console.error('Send test email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/lor/requests/student — Student gets their own ───
router.get('/requests/student', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabaseAdmin
      .from('lor_requests')
      .select('*')
      .eq('student_id', userId)
      .order('requested_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ requests: data || [] });
  } catch (err) {
    console.error('Get student LOR requests error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as lorRouter };
