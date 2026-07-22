import { supabaseAdmin } from '../config/supabase.js';
import { randomBytes } from 'crypto';

export function createShareToken() {
  return randomBytes(24).toString('hex');
}

export async function loadStudentPublicSnapshot(studentId: string) {
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, avatar, role')
    .eq('id', studentId)
    .eq('role', 'STUDENT')
    .maybeSingle();

  if (userError || !user) {
    throw Object.assign(new Error('Student not found'), { status: 404 });
  }

  const { data: profile } = await supabaseAdmin
    .from('student_profiles')
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  const [{ data: experiences }, { data: documents }, { data: dexterity }] = await Promise.all([
    supabaseAdmin
      .from('experiences')
      .select('id, title, category, organization, description, start_date, end_date')
      .eq('student_id', studentId)
      .order('start_date', { ascending: false }),
    supabaseAdmin
      .from('student_documents')
      .select('id, title, type, status, uploaded_at')
      .eq('student_id', studentId)
      .order('uploaded_at', { ascending: false }),
    supabaseAdmin
      .from('student_dexterity')
      .select('id, activity, description, start_date, end_date, is_ongoing')
      .eq('student_id', studentId)
      .order('start_date', { ascending: false }),
  ]);

  return {
    student: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      state: profile?.state ?? null,
      zip_code: profile?.zip_code ?? null,
      country: profile?.country ?? null,
      ethnicity: profile?.ethnicity ?? null,
      gender: profile?.gender ?? null,
      age: profile?.age ?? null,
      gpa: profile?.gpa ?? null,
      dat_score: profile?.dat_score ?? null,
      dat_aa: profile?.dat_aa ?? null,
      dat_ts: profile?.dat_ts ?? null,
      gpa_verified: !!profile?.gpa_verified,
      dat_verified: !!profile?.dat_verified,
      undergrad_institution: profile?.undergrad_institution ?? null,
      undergrad_degree: profile?.undergrad_degree ?? null,
      undergrad_grad_year: profile?.undergrad_grad_year ?? null,
      strength_score: profile?.strength_score ?? null,
      status: profile?.status ?? null,
      is_reapplicant: !!profile?.is_reapplicant,
      application_cycle: profile?.application_cycle ?? null,
      timezone: profile?.timezone ?? null,
      post_bac: profile?.post_bac ?? null,
      masters: profile?.masters ?? null,
    },
    experiences: experiences || [],
    documents: documents || [],
    dexterity: dexterity || [],
  };
}

export async function assertCanManageStudentShare(
  requesterId: string,
  requesterRole: string,
  studentId: string,
) {
  if (requesterRole === 'ADMIN' || requesterRole === 'MENTOR_MANAGER') return;

  if (requesterRole === 'STUDENT') {
    if (requesterId !== studentId) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    return;
  }

  if (requesterRole === 'MENTOR') {
    const { data: profile } = await supabaseAdmin
      .from('student_profiles')
      .select('mentor_id')
      .eq('id', studentId)
      .maybeSingle();
    if (!profile || profile.mentor_id !== requesterId) {
      throw Object.assign(new Error('You are not assigned to this student'), { status: 403 });
    }
    return;
  }

  throw Object.assign(new Error('Forbidden'), { status: 403 });
}
