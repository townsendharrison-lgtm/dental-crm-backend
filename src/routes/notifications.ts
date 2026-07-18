import { Router, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { messaging } from '../config/firebase.js';

const router = Router();

// All notification routes require authentication
router.use(authenticate);

// ─── GET /api/notifications ───────────────────────────────────────────
// Fetch current user's notifications (optionally only unread)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const unreadOnly = req.query.unread === 'true';

    let query = supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (unreadOnly) {
      query = query.eq('is_read', false);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ notifications: data || [] });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/notifications/unread-count ──────────────────────────────
// Get count of unread notifications
router.get('/unread-count', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { count, error } = await supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ count: count || 0 });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/notifications/:id/read ────────────────────────────────
// Mark a single notification as read
router.patch('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/notifications/read-all ────────────────────────────────
// Mark all notifications as read for the current user
router.patch('/read-all', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/notifications/:id ────────────────────────────────────
// Delete a single notification
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/notifications/register-token ───────────────────────────
// Save an FCM device token for the authenticated user
router.post('/register-token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { token, deviceInfo } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Upsert: insert or update if token already exists for this user
    const { error } = await supabaseAdmin
      .from('fcm_tokens')
      .upsert(
        {
          user_id: userId,
          token,
          device_info: deviceInfo || 'Unknown',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,token' }
      );

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    console.log(`📱 FCM token registered for user ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Register token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/notifications/unregister-token ───────────────────────
// Remove an FCM token (called on logout)
router.delete('/unregister-token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { error } = await supabaseAdmin
      .from('fcm_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('token', token);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Unregister token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/notifications/broadcast ────────────────────────────────
// Admin/Manager: send a system alert to all users matching targetRole
router.post('/broadcast', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { title, message, type = 'INFO', targetRole = 'BOTH' } = req.body as {
      title?: string;
      message?: string;
      type?: 'INFO' | 'WARNING' | 'URGENT';
      targetRole?: 'STUDENT' | 'MENTOR' | 'BOTH';
    };

    if (!title?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    const allowedTypes = ['INFO', 'WARNING', 'URGENT'];
    const notifType = allowedTypes.includes(type) ? type : 'INFO';
    const roleTarget = ['STUDENT', 'MENTOR', 'BOTH'].includes(targetRole) ? targetRole : 'BOTH';

    let usersQuery = supabaseAdmin.from('users').select('id, role');
    if (roleTarget === 'STUDENT') {
      usersQuery = usersQuery.eq('role', 'STUDENT');
    } else if (roleTarget === 'MENTOR') {
      usersQuery = usersQuery.in('role', ['MENTOR', 'MENTOR_MANAGER']);
    } else {
      usersQuery = usersQuery.in('role', ['STUDENT', 'MENTOR', 'MENTOR_MANAGER', 'ADMIN']);
    }

    const { data: users, error: usersError } = await usersQuery;
    if (usersError) {
      return res.status(500).json({ error: usersError.message });
    }
    if (!users || users.length === 0) {
      return res.json({ success: true, notified: 0, broadcast: null });
    }

    const batchId = crypto.randomUUID();
    const relatedId = `broadcast:${roleTarget}:${batchId}`;

    const rows = users.map((u: { id: string }) => ({
      user_id: u.id,
      title: title.trim(),
      message: message.trim(),
      type: notifType,
      category: 'BROADCAST',
      related_id: relatedId,
      is_read: false,
      created_by: req.user!.id,
    }));

    const { error: insertError } = await supabaseAdmin.from('notifications').insert(rows);
    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    // Optional FCM push to recipients
    let pushSent = 0;
    if (messaging) {
      const userIds = users.map((u: { id: string }) => u.id);
      const { data: tokens } = await supabaseAdmin
        .from('fcm_tokens')
        .select('token')
        .in('user_id', userIds);

      if (tokens && tokens.length > 0) {
        const tokenStrings = tokens.map((t: { token: string }) => t.token);
        try {
          const response = await messaging.sendEachForMulticast({
            tokens: tokenStrings,
            notification: { title: title.trim(), body: message.trim().slice(0, 180) },
            webpush: {
              fcmOptions: { link: process.env.FRONTEND_URL || 'http://localhost:3000' },
            },
            data: { type: 'BROADCAST', relatedId },
          });
          pushSent = response.successCount;
        } catch (fcmError) {
          console.error('Broadcast FCM error:', fcmError);
        }
      }
    }

    res.status(201).json({
      success: true,
      notified: users.length,
      pushSent,
      broadcast: {
        id: relatedId,
        title: title.trim(),
        message: message.trim(),
        type: notifType,
        targetRole: roleTarget,
        target_role: roleTarget,
        category: 'BROADCAST',
        related_id: relatedId,
        created_by: req.user!.id,
        createdBy: req.user!.id,
        created_at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        notified: users.length,
      },
    });
  } catch (error) {
    console.error('Broadcast notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/notifications/broadcasts ────────────────────────────────
// Admin/Manager: list recent broadcast alerts (grouped by related_id)
router.get('/broadcasts', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('id, title, message, type, category, related_id, created_at, created_by')
      .eq('category', 'BROADCAST')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const seen = new Set<string>();
    const broadcasts = [];
    for (const row of data || []) {
      const key = row.related_id || row.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = String(row.related_id || '').split(':');
      const targetRole = (parts[0] === 'broadcast' && parts[1] ? parts[1] : 'BOTH') as
        | 'STUDENT'
        | 'MENTOR'
        | 'BOTH';
      broadcasts.push({
        id: key,
        title: row.title,
        message: row.message,
        type: row.type,
        category: row.category,
        related_id: row.related_id,
        targetRole,
        target_role: targetRole,
        created_at: row.created_at,
        createdAt: row.created_at,
        created_by: row.created_by,
        createdBy: row.created_by,
      });
      if (broadcasts.length >= 50) break;
    }

    res.json({ broadcasts });
  } catch (error) {
    console.error('List broadcasts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/notifications/broadcasts/:relatedId ──────────────────
// Admin/Manager: remove all notification rows for a broadcast batch
router.delete('/broadcasts/:relatedId', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const relatedId = decodeURIComponent(req.params.relatedId);
    if (!relatedId.startsWith('broadcast:')) {
      return res.status(400).json({ error: 'Invalid broadcast id' });
    }

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('related_id', relatedId)
      .eq('category', 'BROADCAST');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete broadcast error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/notifications/new-lead ─────────────────────────────────
// Trigger: Creates in-app notification for all Admins + sends FCM push
// Called when a Setter adds a new lead
router.post('/new-lead', authorize('SETTER', 'ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { lead, setterName } = req.body;

    if (!lead || !lead.name) {
      return res.status(400).json({ error: 'Lead data is required' });
    }

    // 1. Find all Admin users
    const { data: admins, error: adminError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('role', 'ADMIN');

    if (adminError) {
      console.error('Failed to fetch admins:', adminError.message);
      return res.status(500).json({ error: 'Failed to fetch admin users' });
    }

    if (!admins || admins.length === 0) {
      console.warn('No admin users found for notification');
      return res.json({ success: true, notified: 0 });
    }

    // 2. Build notification content with all lead info
    const notifTitle = '🆕 New Lead Added';
    const notifMessage = [
      `${lead.name} has been added as a new lead by ${setterName || 'a setter'}.`,
      `📞 ${lead.phone || 'N/A'} · 📧 ${lead.email || 'N/A'}`,
      `Source: ${lead.source || 'Unknown'}`,
      lead.notes ? `Notes: ${lead.notes}` : '',
    ].filter(Boolean).join('\n');

    // 3. Insert in-app notification for each Admin
    const notificationRows = admins.map((admin: { id: string }) => ({
      user_id: admin.id,
      title: notifTitle,
      message: notifMessage,
      type: 'URGENT' as const,
      category: 'NEW_LEAD',
      related_id: lead.id || null,
      is_read: false,
      created_by: req.user!.id,
    }));

    const { error: insertError } = await supabaseAdmin
      .from('notifications')
      .insert(notificationRows);

    if (insertError) {
      console.error('Failed to insert notifications:', insertError.message);
    } else {
      console.log(`📬 In-app notifications created for ${admins.length} admin(s)`);
    }

    // 4. Send FCM push notifications to all Admin devices
    let pushCount = 0;
    if (messaging) {
      // Fetch all FCM tokens for admin users
      const adminIds = admins.map((a: { id: string }) => a.id);
      const { data: tokens, error: tokenError } = await supabaseAdmin
        .from('fcm_tokens')
        .select('token')
        .in('user_id', adminIds);

      if (tokenError) {
        console.error('Failed to fetch FCM tokens:', tokenError.message);
      } else if (tokens && tokens.length > 0) {
        const tokenStrings = tokens.map((t: { token: string }) => t.token);

        // FCM push body (plain text, more concise)
        const pushTitle = `New Lead: ${lead.name}`;
        const pushBody = [
          `📞 ${lead.phone || 'N/A'} · 📧 ${lead.email || 'N/A'}`,
          `Source: ${lead.source || 'Unknown'} · By: ${setterName || 'Setter'}`,
          lead.notes ? `${lead.notes.substring(0, 100)}` : '',
        ].filter(Boolean).join('\n');

        try {
          const response = await messaging.sendEachForMulticast({
            tokens: tokenStrings,
            notification: {
              title: pushTitle,
              body: pushBody,
            },
            webpush: {
              fcmOptions: {
                link: process.env.FRONTEND_URL || 'http://localhost:3000',
              },
              notification: {
                icon: 'https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng',
                badge: 'https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng',
              },
            },
            data: {
              type: 'NEW_LEAD',
              leadId: lead.id || '',
              leadName: lead.name || '',
            },
          });

          pushCount = response.successCount;
          console.log(`🔔 FCM push sent: ${response.successCount} success, ${response.failureCount} failed`);

          // Clean up invalid tokens
          if (response.failureCount > 0) {
            const invalidTokens: string[] = [];
            response.responses.forEach((r, idx) => {
              if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
                invalidTokens.push(tokenStrings[idx]);
              }
            });
            if (invalidTokens.length > 0) {
              await supabaseAdmin
                .from('fcm_tokens')
                .delete()
                .in('token', invalidTokens);
              console.log(`🧹 Cleaned up ${invalidTokens.length} invalid FCM token(s)`);
            }
          }
        } catch (fcmError) {
          console.error('FCM send error:', fcmError);
        }
      }
    } else {
      console.log('⚠️ FCM messaging not initialized — skipping push notifications');
    }

    res.json({
      success: true,
      notified: admins.length,
      pushSent: pushCount,
    });
  } catch (error) {
    console.error('New lead notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE all notifications for the current user ────────────────────
router.delete('/clear-all', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('user_id', userId);

    if (error) {
      console.error('Clear all notifications error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Clear all notifications error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as notificationRouter };

