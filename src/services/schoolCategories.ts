import { supabaseAdmin } from '../config/supabase.js';

export type SchoolCategoryRow = {
  id: string;
  name: string;
  color: string;
  icon: string;
};

export const DEFAULT_SCHOOL_CATEGORIES: SchoolCategoryRow[] = [
  { id: 'Reach', name: 'Reach', color: '#f43f5e', icon: 'Target' },
  { id: 'Target', name: 'Target', color: '#6366f1', icon: 'CheckCircle2' },
  { id: 'Strong Fit', name: 'Strong Fit', color: '#10b981', icon: 'TrendingUp' },
];

function mapRow(row: any): SchoolCategoryRow {
  return {
    id: row.category_key || row.id,
    name: row.name,
    color: row.color || '#6366f1',
    icon: row.icon || 'SchoolIcon',
  };
}

/** List categories for a student. Empty table → defaults (not seeded until first save). */
export async function listStudentSchoolCategories(studentId: string): Promise<SchoolCategoryRow[]> {
  const { data, error } = await supabaseAdmin
    .from('student_school_categories')
    .select('*')
    .eq('student_id', studentId)
    .order('sort_order', { ascending: true });

  if (error) {
    // Table missing / not migrated yet
    console.error('listStudentSchoolCategories error:', error.message);
    return DEFAULT_SCHOOL_CATEGORIES;
  }

  if (!data || data.length === 0) {
    return DEFAULT_SCHOOL_CATEGORIES;
  }

  return data.map(mapRow);
}

/** Replace all categories for a student (full snapshot). */
export async function replaceStudentSchoolCategories(
  studentId: string,
  categories: SchoolCategoryRow[],
): Promise<SchoolCategoryRow[]> {
  const cleaned = (categories || [])
    .filter((c) => c && (c.id || c.name))
    .map((c, index) => ({
      student_id: studentId,
      category_key: String(c.id || c.name).trim(),
      name: String(c.name || c.id).trim(),
      color: c.color || '#6366f1',
      icon: c.icon || 'SchoolIcon',
      sort_order: index,
      updated_at: new Date().toISOString(),
    }))
    .filter((c) => c.category_key && c.name);

  if (cleaned.length === 0) {
    throw new Error('At least one category is required');
  }

  const { error: delError } = await supabaseAdmin
    .from('student_school_categories')
    .delete()
    .eq('student_id', studentId);

  if (delError) {
    console.error('replaceStudentSchoolCategories delete error:', delError.message);
    throw new Error(delError.message);
  }

  const { data, error: insertError } = await supabaseAdmin
    .from('student_school_categories')
    .insert(cleaned)
    .select('*')
    .order('sort_order', { ascending: true });

  if (insertError) {
    console.error('replaceStudentSchoolCategories insert error:', insertError.message);
    throw new Error(insertError.message);
  }

  // Best-effort legacy mirror on student_profiles.school_categories (migration 031)
  const mirrored = (data || []).map(mapRow);
  await supabaseAdmin
    .from('student_profiles')
    .update({
      school_categories: mirrored,
      updated_at: new Date().toISOString(),
    })
    .eq('id', studentId);

  return mirrored;
}
