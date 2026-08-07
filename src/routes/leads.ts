import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { dismissRelatedNotifications } from '../services/dismissNotifications.js';

const router = Router();

// GET /api/leads - Fetch leads
// Admins can see all leads, Setters see only their own.
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let query = supabaseAdmin
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false });

    // If not admin, restrict to their own leads
    if (userRole !== 'ADMIN') {
      query = query.eq('setter_id', userId);
    }

    const { data: leads, error } = await query;

    if (error) {
      console.error('Error fetching leads:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ leads });
  } catch (error) {
    console.error('Server error fetching leads:', error);
    res.status(500).json({ error: 'Server error fetching leads' });
  }
});

// POST /api/leads - Create a new lead
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, phone, email, source, notes, adminNotes, 
      contacted, isPaid, showedUp, purchasedItems, purchaseTotal, setterId
    } = req.body;

    const userRole = req.user?.role;
    const finalSetterId = userRole === 'ADMIN' ? (setterId || req.user?.id) : req.user?.id;

    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .insert([
        {
          name,
          phone,
          email,
          source,
          notes,
          admin_notes: adminNotes,
          contacted,
          is_paid: isPaid,
          showed_up: showedUp,
          purchased_items: purchasedItems || [],
          purchase_total: purchaseTotal || 0,
          setter_id: finalSetterId
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Error creating lead:', error);
      return res.status(500).json({ error: error.message });
    }

    // Notify admins only (best-effort; never block lead creation)
    try {
      const setterId = finalSetterId || req.user?.id;
      let setterName = 'A setter';
      if (setterId) {
        const { data: setter } = await supabaseAdmin
          .from('users')
          .select('name')
          .eq('id', setterId)
          .maybeSingle();
        if (setter?.name) setterName = setter.name;
      }

      const { data: admins } = await supabaseAdmin
        .from('users')
        .select('id, role')
        .eq('role', 'ADMIN');

      const adminIds = (admins || [])
        .filter((u: { role?: string }) => String(u.role || '').toUpperCase() === 'ADMIN')
        .map((u: { id: string }) => u.id);

      if (adminIds.length > 0) {
        const notifTitle = '🆕 New Lead Added';
        const notifMessage = [
          `${lead.name} has been added as a new lead by ${setterName}.`,
          `📞 ${lead.phone || 'N/A'} · 📧 ${lead.email || 'N/A'}`,
          `Source: ${lead.source || 'Unknown'}`,
          lead.notes ? `Notes: ${lead.notes}` : '',
        ].filter(Boolean).join('\n');

        await supabaseAdmin.from('notifications').insert(
          adminIds.map((adminId: string) => ({
            user_id: adminId,
            title: notifTitle,
            message: notifMessage,
            type: 'URGENT',
            category: 'NEW_LEAD',
            related_id: lead.id,
            is_read: false,
            created_by: req.user!.id,
          })),
        );
      }
    } catch (notifErr) {
      console.error('Failed to create admin new-lead notifications:', notifErr);
    }

    res.status(201).json({ lead });
  } catch (error) {
    console.error('Server error creating lead:', error);
    res.status(500).json({ error: 'Server error creating lead' });
  }
});

// PUT /api/leads/:id - Update an existing lead
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
    if (updates.email !== undefined) dbUpdates.email = updates.email;
    if (updates.source !== undefined) dbUpdates.source = updates.source;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    if (updates.adminNotes !== undefined) dbUpdates.admin_notes = updates.adminNotes;
    if (updates.contacted !== undefined) dbUpdates.contacted = updates.contacted;
    if (updates.isPaid !== undefined) dbUpdates.is_paid = updates.isPaid;
    if (updates.showedUp !== undefined) dbUpdates.showed_up = updates.showedUp;
    if (updates.purchasedItems !== undefined) dbUpdates.purchased_items = updates.purchasedItems;
    if (updates.purchaseTotal !== undefined) dbUpdates.purchase_total = updates.purchaseTotal;
    
    if (req.user?.role === 'ADMIN' && updates.setterId !== undefined) {
      dbUpdates.setter_id = updates.setterId;
    }

    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating lead:', error);
      return res.status(500).json({ error: error.message });
    }

    // Contacted / paid / showed-up means the new-lead alert has been handled
    if (
      updates.contacted === true ||
      updates.isPaid === true ||
      updates.showedUp === true
    ) {
      await dismissRelatedNotifications({
        category: 'NEW_LEAD',
        relatedId: id,
      });
    }

    res.json({ lead });
  } catch (error) {
    console.error('Server error updating lead:', error);
    res.status(500).json({ error: 'Server error updating lead' });
  }
});

// DELETE /api/leads/:id - Delete a lead
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can delete leads' });
    }

    const { error } = await supabaseAdmin
      .from('leads')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting lead:', error);
      return res.status(500).json({ error: error.message });
    }

    await dismissRelatedNotifications({
      category: 'NEW_LEAD',
      relatedId: id,
    });

    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Server error deleting lead:', error);
    res.status(500).json({ error: 'Server error deleting lead' });
  }
});

export const leadsRouter = router;
