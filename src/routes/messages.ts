import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { messaging } from '../config/firebase.js';
import { extractFirstUrl, fetchLinkPreview } from '../services/linkPreview.js';
import { dismissRelatedNotifications } from '../services/dismissNotifications.js';

const router = Router();

const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Use PNG, JPG, WebP, or GIF.'));
  },
});

function attachmentFileName(conversationId: string, userId: string, originalName: string) {
  const ext = (originalName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${conversationId}/${userId}/${Date.now()}.${ext || 'jpg'}`;
}

// All routes require authentication
router.use(authenticate);

// ─── GET /api/conversations ───────────────────────────────────────────
// List all conversations the authenticated user is participating in
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    // 1. Fetch conversations containing this user in participant_ids
    const { data: conversations, error } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .contains('participant_ids', [userId])
      .order('updated_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    if (!conversations || conversations.length === 0) {
      return res.json({ conversations: [] });
    }

    // Filter out conversations that the user has deleted/hidden
    const activeConversations = conversations.filter(c => {
      const deletedBy = c.deleted_by || [];
      return !deletedBy.includes(userId);
    });

    if (activeConversations.length === 0) {
      return res.json({ conversations: [] });
    }

    // 2. Fetch all participant users profiles
    const allParticipantIds = Array.from(new Set(activeConversations.flatMap(c => c.participant_ids)));
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', allParticipantIds);

    const usersMap = new Map<string, any>();
    if (users) {
      users.forEach(u => usersMap.set(u.id, u));
    }

    // 3. Resolve last message & unread count for each conversation
    const conversationsWithDetails = await Promise.all(
      activeConversations.map(async (conv) => {
        // Resolve participants objects
        const resolvedParticipants = conv.participant_ids
          .map((pId: string) => usersMap.get(pId))
          .filter(Boolean);

        // Fetch last message
        const { data: messages } = await supabaseAdmin
          .from('messages')
          .select('*')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1);

        const lastMessage = messages && messages.length > 0 ? messages[0] : null;

        // Fetch unread count for current user
        // Messages sent by others which are not read (is_read = false)
        const { count } = await supabaseAdmin
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .neq('sender_id', userId)
          .eq('is_read', false);

        return {
          ...conv,
          participants: resolvedParticipants,
          lastMessage,
          unreadCount: count || 0,
        };
      })
    );

    // Sort: pinned first, then updated_at descending
    const sortedConversations = conversationsWithDetails.sort((a, b) => {
      const aPinned = (a.pinned_by || []).includes(userId) ? 1 : 0;
      const bPinned = (b.pinned_by || []).includes(userId) ? 1 : 0;
      if (aPinned !== bPinned) {
        return bPinned - aPinned;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    res.json({ conversations: sortedConversations });
  } catch (error: any) {
    console.error('Fetch conversations error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/conversations/:id ───────────────────────────────────────
// Fetch single conversation details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: conv, error } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Authorization: User must be a participant
    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    // Fetch participant user info
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', conv.participant_ids);

    res.json({
      ...conv,
      participants: users || [],
    });
  } catch (error: any) {
    console.error('Fetch conversation error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/conversations ──────────────────────────────────────────
// Create a new conversation (DM or Group)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    if (req.user!.role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot start new conversations' });
    }

    const { participantIds, isGroup = false, name } = req.body;

    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ error: 'Participant IDs array is required' });
    }

    // Ensure current user is in the participants list
    const uniqueIds = Array.from(new Set([...participantIds, userId]));

    // If it's a 1-to-1 conversation, check if one already exists
    if (!isGroup && uniqueIds.length === 2) {
      const otherUserId = uniqueIds.find(id => id !== userId);
      const { data: existing } = await supabaseAdmin
        .from('conversations')
        .select('*')
        .eq('is_group', false)
        .contains('participant_ids', [userId, otherUserId]);

      // Verify exact matching (length = 2) to avoid matching groups with same subsets
      const exactMatch = existing?.find(c => c.participant_ids.length === 2);
      if (exactMatch) {
        // Fetch participant details for the existing conversation
        const { data: users } = await supabaseAdmin
          .from('users')
          .select('id, name, email, avatar, role')
          .in('id', exactMatch.participant_ids);

        return res.json({
          ...exactMatch,
          participants: users || [],
          isExisting: true
        });
      }
    }

    // Create new conversation
    const { data: newConv, error } = await supabaseAdmin
      .from('conversations')
      .insert({
        name: isGroup ? (name || 'Group Chat') : null,
        participant_ids: uniqueIds,
        is_group: isGroup
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Fetch details
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', uniqueIds);

    res.status(201).json({
      ...newConv,
      participants: users || [],
      isExisting: false
    });
  } catch (error: any) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/conversations/:id/messages ──────────────────────────────
// Fetch messages inside a conversation (paginated)
router.get('/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before as string; // Timestamp ISO

    // 1. Verify user is in conversation
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('participant_ids')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // 2. Fetch messages
    let query = supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error: msgErr } = await query;

    if (msgErr) {
      return res.status(400).json({ error: msgErr.message });
    }

    // Return messages in chronological order for frontend chat rendering
    res.json({ messages: (messages || []).reverse() });
  } catch (error: any) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/conversations/:id/messages ─────────────────────────────
// Send a message (text and/or image) + Trigger Push & In-app notifications
router.post('/:id/messages', (req: AuthRequest, res: Response, next: NextFunction) => {
  messageUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'File upload failed';
      return res.status(400).json({ error: message });
    }
    next();
  });
}, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
    const text = rawText.trim();
    const file = req.file;

    if (!text && !file) {
      return res.status(400).json({ error: 'Message text or image is required' });
    }

    // 1. Verify user participates
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get sender name
    const { data: senderUser } = await supabaseAdmin
      .from('users')
      .select('name')
      .eq('id', userId)
      .single();

    const senderName = senderUser?.name || 'Someone';

    let attachmentUrl: string | null = null;
    let attachmentType: string | null = null;
    let attachmentName: string | null = null;

    if (file) {
      const filePath = attachmentFileName(id, userId, file.originalname);
      const { error: uploadError } = await supabaseAdmin.storage
        .from('message-attachments')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('Message attachment upload error:', uploadError.message);
        return res.status(500).json({ error: 'Image upload failed: ' + uploadError.message });
      }

      const { data: publicData } = supabaseAdmin.storage
        .from('message-attachments')
        .getPublicUrl(filePath);
      attachmentUrl = publicData.publicUrl;
      attachmentType = file.mimetype;
      attachmentName = file.originalname;
    }

    // Best-effort Open Graph preview for the first URL in the caption/text
    let linkPreview = null;
    const firstUrl = extractFirstUrl(text);
    if (firstUrl) {
      linkPreview = await fetchLinkPreview(firstUrl);
    }

    // 2. Insert message
    const { data: message, error: msgErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: id,
        sender_id: userId,
        text: text || '',
        attachment_url: attachmentUrl,
        attachment_type: attachmentType,
        attachment_name: attachmentName,
        link_preview: linkPreview,
        read_by: [userId], // Sender has read their own message
      })
      .select()
      .single();

    if (msgErr) {
      return res.status(400).json({ error: msgErr.message });
    }

    const notificationBody = text
      ? text
      : attachmentUrl
        ? 'Sent an image'
        : 'New message';

    // 3. Process Notifications for all other participants
    const recipients = conv.participant_ids.filter((pId: string) => pId !== userId);

    if (recipients.length > 0) {
      // a. Insert In-App Notification
      const inboxTitle = conv.is_group
        ? `Inbox: ${conv.name || 'Group'}`
        : `Inbox: ${senderName}`;
      const notificationRows = recipients.map((rId: string) => ({
        user_id: rId,
        title: inboxTitle,
        message: notificationBody,
        type: 'INFO' as const,
        category: 'NEW_MESSAGE',
        related_id: id,
        is_read: false,
        created_by: userId,
      }));

      const { error: notifErr } = await supabaseAdmin
        .from('notifications')
        .insert(notificationRows);

      if (notifErr) {
        console.error('Failed to create in-app notifications:', notifErr.message);
      }

      // b. Send FCM Push Notification
      if (messaging) {
        const { data: tokens, error: tErr } = await supabaseAdmin
          .from('fcm_tokens')
          .select('token')
          .in('user_id', recipients);

        if (tErr) {
          console.error('Failed to retrieve recipient FCM tokens:', tErr.message);
        } else if (tokens && tokens.length > 0) {
          const tokenStrings = tokens.map((t: { token: string }) => t.token);
          const pushTitle = conv.is_group
            ? `Inbox: ${conv.name || 'Group Chat'}`
            : `Inbox: ${senderName}`;
          const pushBody = notificationBody.substring(0, 200);

          try {
            const response = await messaging.sendEachForMulticast({
              tokens: tokenStrings,
              notification: {
                title: pushTitle,
                body: pushBody,
              },
              data: {
                type: 'NEW_MESSAGE',
                conversationId: id,
              },
            });

            console.log(`🔔 FCM push message sent: ${response.successCount} success, ${response.failureCount} failed`);

            // Clean invalid tokens
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
              }
            }
          } catch (fcmErr) {
            console.error('FCM send error during messaging:', fcmErr);
          }
        }
      }
    }

    // 4. Trigger Auto-Reply if sender is a STUDENT
    if (req.user!.role === 'STUDENT' && !conv.is_group && recipients.length === 1) {
      try {
        const { data: config } = await supabaseAdmin
          .from('admin_settings')
          .select(
            'auto_reply_enabled, auto_reply_message, auto_reply_inactivity_minutes, auto_reply_rate_limit_minutes'
          )
          .eq('id', 1)
          .maybeSingle();

        if (config?.auto_reply_enabled && config?.auto_reply_message) {
          const mentorId = recipients[0];
          const autoReplyText = config.auto_reply_message;
          const inactivityMinutes = Number(config.auto_reply_inactivity_minutes ?? 120);
          const rateLimitMinutes = Number(config.auto_reply_rate_limit_minutes ?? 1440);

          const { data: otherUser } = await supabaseAdmin
            .from('users')
            .select('role, name')
            .eq('id', mentorId)
            .maybeSingle();

          if (
            otherUser &&
            (otherUser.role === 'MENTOR' ||
              otherUser.role === 'ADMIN' ||
              otherUser.role === 'MENTOR_MANAGER')
          ) {
            const { data: lastMentorMessages } = await supabaseAdmin
              .from('messages')
              .select('created_at, text')
              .eq('conversation_id', id)
              .eq('sender_id', mentorId)
              .order('created_at', { ascending: false })
              .limit(20);

            let shouldSendAutoReply = true;
            const now = Date.now();
            const inactivityMs = inactivityMinutes * 60 * 1000;
            const rateLimitMs = rateLimitMinutes * 60 * 1000;

            if (lastMentorMessages && lastMentorMessages.length > 0) {
              const lastMessageTime = new Date(lastMentorMessages[0].created_at).getTime();
              // Mentor still "active" within inactivity window → skip
              if (now - lastMessageTime < inactivityMs) {
                shouldSendAutoReply = false;
              }

              // Rate-limit: another auto-reply (matching template) was sent too recently
              const recentAutoReply = lastMentorMessages.find(
                (m) =>
                  m.text === autoReplyText &&
                  now - new Date(m.created_at).getTime() < rateLimitMs
              );
              if (recentAutoReply) {
                shouldSendAutoReply = false;
              }
            }

            if (shouldSendAutoReply) {
              await supabaseAdmin.from('messages').insert({
                conversation_id: id,
                sender_id: mentorId,
                text: autoReplyText,
                read_by: [mentorId],
              });

              await supabaseAdmin.from('notifications').insert({
                user_id: userId,
                title: `Inbox: ${otherUser.name || 'Advisor'}`,
                message: autoReplyText,
                type: 'INFO',
                category: 'NEW_MESSAGE',
                related_id: id,
                is_read: false,
                created_by: mentorId,
              });
            }
          }
        }
      } catch (arErr) {
        console.error('Auto-reply trigger error:', arErr);
      }

      // Refresh student avg response time from mentor/admin DMs (fire-and-forget)
      void import('../services/studentResponseTime.js')
        .then(({ recalculateStudentResponseTime }) =>
          recalculateStudentResponseTime(userId),
        )
        .catch((err) => console.error('Response time recalc error:', err));
    }

    // Refresh mentor avg response time when a mentor replies in a 1:1 DM
    if (req.user!.role === 'MENTOR' && !conv.is_group) {
      void import('../services/mentorResponseTime.js')
        .then(({ recalculateMentorResponseTime }) =>
          recalculateMentorResponseTime(userId),
        )
        .catch((err) => console.error('Mentor response time recalc error:', err));
    }

    res.status(201).json(message);
  } catch (error: any) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/conversations/:id/read ─────────────────────────────────
// Mark all messages in a conversation as read for the current user
router.post('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // 1. Verify user is participant
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('participant_ids')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // 2. Mark messages as read where sender is not current user
    // A message is read if current user's ID is in the read_by array or is_read is true
    // Update is_read = true (for 1-on-1 simplicity)
    await supabaseAdmin
      .from('messages')
      .update({ is_read: true })
      .eq('conversation_id', id)
      .neq('sender_id', userId)
      .eq('is_read', false);

    // Also append user ID to read_by array if not already present
    // Using Supabase RPC or direct raw query is sometimes needed for array append, 
    // but in express we can easily run a direct raw RPC or updates.
    // For general compatibility:
    const { error: updateErr } = await supabaseAdmin.rpc('mark_messages_read_by_user', {
      p_conversation_id: id,
      p_user_id: userId
    });

    if (updateErr) {
      // Fallback: If RPC function is not created, we at least updated is_read = true. 
      // Let's create the RPC SQL function in the migration file to be safe.
      console.warn('RPC mark_messages_read_by_user failed:', updateErr.message);
    }

    // Opening/reading the thread clears inbox message alerts for this conversation
    await dismissRelatedNotifications({
      category: 'NEW_MESSAGE',
      relatedId: id,
      userId,
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/conversations/:id/pin ──────────────────────────────────
router.post('/:id/pin', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const pinnedBy = conv.pinned_by || [];
    if (!pinnedBy.includes(userId)) {
      const { error: updateErr } = await supabaseAdmin
        .from('conversations')
        .update({
          pinned_by: [...pinnedBy, userId]
        })
        .eq('id', id);

      if (updateErr) {
        return res.status(400).json({ error: updateErr.message });
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/conversations/:id/unpin ────────────────────────────────
router.post('/:id/unpin', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const pinnedBy = conv.pinned_by || [];
    if (pinnedBy.includes(userId)) {
      const { error: updateErr } = await supabaseAdmin
        .from('conversations')
        .update({
          pinned_by: pinnedBy.filter((uid: string) => uid !== userId)
        })
        .eq('id', id);

      if (updateErr) {
        return res.status(400).json({ error: updateErr.message });
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/conversations/:id ────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    if (req.user!.role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot delete conversations' });
    }

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const deletedBy = conv.deleted_by || [];
    if (!deletedBy.includes(userId)) {
      const { error: updateErr } = await supabaseAdmin
        .from('conversations')
        .update({
          deleted_by: [...deletedBy, userId]
        })
        .eq('id', id);

      if (updateErr) {
        return res.status(400).json({ error: updateErr.message });
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/conversations/:id/rename ────────────────────────────────
router.put('/:id/rename', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name } = req.body;

    if (req.user!.role === 'STUDENT') {
      return res.status(403).json({ error: 'Students cannot rename group chats' });
    }

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'New name is required' });
    }

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.participant_ids.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!conv.is_group) {
      return res.status(400).json({ error: 'Only group chats can be renamed' });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('conversations')
      .update({
        name: name.trim()
      })
      .eq('id', id);

    if (updateErr) {
      return res.status(400).json({ error: updateErr.message });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/conversations/:id/members ─────────────────────────────
// Add members to a group conversation
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { userIds } = req.body as { userIds?: string[] };

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds array is required' });
    }

    const { data: conv, error } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!conv.participant_ids?.includes(userId)) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }
    if (!conv.is_group) {
      return res.status(400).json({ error: 'Only group chats can add members' });
    }

    const nextIds = Array.from(new Set([...(conv.participant_ids || []), ...userIds]));
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('conversations')
      .update({ participant_ids: nextIds, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) return res.status(400).json({ error: updateErr.message });

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, role, avatar')
      .in('id', nextIds);

    res.json({ ...updated, participants: users || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/conversations/:id/members/:memberId ─────────────────
// Remove a member from a group conversation
router.delete('/:id/members/:memberId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id, memberId } = req.params;

    const { data: conv, error } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!conv.participant_ids?.includes(userId)) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }
    if (!conv.is_group) {
      return res.status(400).json({ error: 'Only group chats can remove members' });
    }
    if (memberId === userId) {
      return res.status(400).json({ error: 'Use leave/delete to remove yourself from the chat' });
    }

    const nextIds = (conv.participant_ids || []).filter((pid: string) => pid !== memberId);
    if (nextIds.length < 2) {
      return res.status(400).json({ error: 'Group must keep at least two participants' });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('conversations')
      .update({ participant_ids: nextIds, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) return res.status(400).json({ error: updateErr.message });

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, role, avatar')
      .in('id', nextIds);

    res.json({ ...updated, participants: users || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const messagesRouter = router;
