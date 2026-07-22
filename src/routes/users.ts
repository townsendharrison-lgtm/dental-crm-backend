import { Router, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Use PNG, JPG, or WebP.'));
  },
});

function avatarFileName(userId: string, originalName: string) {
  const ext = (originalName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${userId}/${Date.now()}.${ext || 'jpg'}`;
}

// Get user profile
router.get('/profile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', req.user!.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
router.put('/profile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, avatar, weeklyLeadGoal, monthlyLeadGoal } = req.body;

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .update({
        name,
        avatar,
        weekly_lead_goal: weeklyLeadGoal,
        monthly_lead_goal: monthlyLeadGoal,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.user!.id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(user);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/users/avatar
 * Upload a profile photo for the current user (any role) to the `avatars` bucket.
 * Optional body field `userId` lets ADMIN / MENTOR_MANAGER update another user's avatar.
 */
router.post(
  '/avatar',
  authenticate,
  avatarUpload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'Image file is required' });
      }

      const role = req.user!.role;
      const requestedUserId = typeof req.body?.userId === 'string' ? req.body.userId : undefined;
      let targetUserId = req.user!.id;

      if (requestedUserId && requestedUserId !== req.user!.id) {
        if (role !== 'ADMIN' && role !== 'MENTOR_MANAGER') {
          return res.status(403).json({ error: 'You can only update your own profile photo' });
        }
        targetUserId = requestedUserId;
      }

      const filePath = avatarFileName(targetUserId, file.originalname);
      const { error: uploadError } = await supabaseAdmin.storage
        .from('avatars')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error('Avatar upload error:', uploadError.message);
        return res.status(500).json({ error: 'Avatar upload failed: ' + uploadError.message });
      }

      const { data: publicData } = supabaseAdmin.storage.from('avatars').getPublicUrl(filePath);
      const avatarUrl = publicData.publicUrl;

      const { data: user, error } = await supabaseAdmin
        .from('users')
        .update({
          avatar: avatarUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetUserId)
        .select('*')
        .single();

      if (error || !user) {
        return res.status(500).json({ error: error?.message || 'Failed to save avatar' });
      }

      res.json(user);
    } catch (error: any) {
      console.error('Upload avatar error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  },
);

// Get users by role (for admin/mentor manager)
router.get('/role/:role', authenticate, authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { role } = req.params;

    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('role', role);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(users);
  } catch (error) {
    console.error('Get users by role error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as userRouter };
