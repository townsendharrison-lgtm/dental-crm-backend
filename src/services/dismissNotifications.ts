import { supabaseAdmin } from '../config/supabase.js';

export interface DismissRelatedOptions {
  category: string;
  relatedId: string;
  /** If set, only dismiss for this user; otherwise dismiss for all users. */
  userId?: string;
}

/**
 * Remove action-required notifications once the related work is done
 * (accept assignment, review LOR, contact lead, etc.).
 */
export async function dismissRelatedNotifications(
  opts: DismissRelatedOptions,
): Promise<number> {
  const relatedId = String(opts.relatedId || '').trim();
  const category = String(opts.category || '').trim();
  if (!relatedId || !category) return 0;

  let query = supabaseAdmin
    .from('notifications')
    .delete()
    .eq('category', category)
    .eq('related_id', relatedId);

  if (opts.userId) {
    query = query.eq('user_id', opts.userId);
  }

  const { data, error } = await query.select('id');
  if (error) {
    console.warn(
      `dismissRelatedNotifications failed (${category}/${relatedId}):`,
      error.message,
    );
    return 0;
  }
  return data?.length ?? 0;
}

/** Dismiss many related_ids for one category (e.g. prior declined assignments). */
export async function dismissRelatedNotificationsMany(
  category: string,
  relatedIds: Array<string | null | undefined>,
  userId?: string,
): Promise<void> {
  const ids = Array.from(
    new Set(relatedIds.map((id) => String(id || '').trim()).filter(Boolean)),
  );
  await Promise.all(
    ids.map((relatedId) =>
      dismissRelatedNotifications({ category, relatedId, userId }),
    ),
  );
}
