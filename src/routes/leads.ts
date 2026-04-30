import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

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

    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Server error deleting lead:', error);
    res.status(500).json({ error: 'Server error deleting lead' });
  }
});

export const leadsRouter = router;
