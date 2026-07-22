import { supabaseAdmin } from '../config/supabase.js';
import { calculateStrengthScore } from './strengthScore.js';
import { recordStrengthHistoryIfChanged } from './strengthHistory.js';

function experienceHoursByCategory(
  experiences: Array<{ category?: string; sessions?: Array<{ duration?: number }> }>,
) {
  const map: Record<string, number> = {};
  for (const exp of experiences) {
    const cat = exp.category || 'Other';
    const hours = (exp.sessions || []).reduce((sum, s) => sum + Number(s.duration || 0), 0);
    map[cat] = (map[cat] || 0) + hours;
  }
  return map;
}

/**
 * Recalculate strength_score from live profile + experiences + documents and persist.
 * Safe to call fire-and-forget after writes. Also records history when the score changes.
 */
export async function recalculateStudentStrengthScore(studentId: string): Promise<number> {
  try {
    const [{ data: profile }, { data: experiences }, { data: documents }, { data: applications }, { data: studentSchools }] =
      await Promise.all([
        supabaseAdmin.from('student_profiles').select('*').eq('id', studentId).maybeSingle(),
        supabaseAdmin
          .from('experiences')
          .select('id, category, sessions:experience_sessions(duration)')
          .eq('student_id', studentId),
        supabaseAdmin.from('student_documents').select('type').eq('student_id', studentId),
        supabaseAdmin.from('applications').select('id').eq('student_id', studentId),
        supabaseAdmin.from('student_schools').select('id').eq('student_id', studentId),
      ]);

    if (!profile) return 0;

    const lorDocs = (documents || []).filter((d: any) => d.type === 'Letter of Recommendation').length;

    const breakdown = calculateStrengthScore({
      gpa: profile.gpa,
      gpaVerified: profile.gpa_verified,
      datAa: profile.dat_aa,
      datScore: profile.dat_score,
      datVerified: profile.dat_verified,
      hoursByCategory: experienceHoursByCategory(experiences || []),
      documentTypes: (documents || []).map((d: any) => d.type),
      lorRequired: profile.lor_required,
      lorReceivedApprox: lorDocs,
      applicationCount: applications?.length ?? 0,
      schoolCount: studentSchools?.length ?? 0,
      isReapplicant: profile.is_reapplicant,
    });

    const score = breakdown.total;
    const previous = profile.strength_score;

    if (previous !== score) {
      await supabaseAdmin
        .from('student_profiles')
        .update({
          strength_score: score,
          updated_at: new Date().toISOString(),
        })
        .eq('id', studentId);

      await recordStrengthHistoryIfChanged(studentId, previous, score);
    } else {
      // Ensure at least one history row exists for progression charts
      const { count } = await supabaseAdmin
        .from('student_strength_history')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', studentId);

      if (!count) {
        await recordStrengthHistoryIfChanged(studentId, null, score);
      }
    }

    return score;
  } catch (err) {
    console.error('recalculateStudentStrengthScore error:', err);
    return 0;
  }
}
