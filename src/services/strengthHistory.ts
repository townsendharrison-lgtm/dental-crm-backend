import { supabaseAdmin } from '../config/supabase.js';

/**
 * Insert a history row when the strength score changes.
 * Safe no-op if the migration table is missing.
 */
export async function recordStrengthHistoryIfChanged(
  studentId: string,
  previousScore: number | null | undefined,
  nextScore: number,
) {
  const prev = previousScore == null ? null : Number(previousScore);
  const next = Math.max(0, Math.min(100, Math.round(Number(nextScore) || 0)));

  if (prev !== null && prev === next) return;

  const { error } = await supabaseAdmin.from('student_strength_history').insert({
    student_id: studentId,
    strength_score: next,
    recorded_at: new Date().toISOString(),
  });

  if (error) {
    console.error('recordStrengthHistoryIfChanged error:', error.message);
  }
}

/**
 * List strength history ascending by time.
 * Seeds from the current profile score when empty / table missing so charts still render.
 */
export async function listStrengthHistory(studentId: string) {
  const { data: profile } = await supabaseAdmin
    .from('student_profiles')
    .select('id, strength_score, updated_at, created_at')
    .eq('id', studentId)
    .maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('student_strength_history')
    .select('*')
    .eq('student_id', studentId)
    .order('recorded_at', { ascending: true });

  if (!error && data && data.length > 0) {
    // Collapse consecutive duplicate scores from concurrent recalcs
    const unique: typeof data = [];
    let lastScore: number | null = null;
    for (const row of data) {
      const score = Math.round(Number(row.strength_score) || 0);
      if (lastScore === score) continue;
      unique.push(row);
      lastScore = score;
    }

    const last = unique[unique.length - 1];
    const current = Math.round(Number(profile?.strength_score) || 0);
    const lastScoreValue = Math.round(Number(last?.strength_score) || 0);

    // Only append the profile score when it is newer than the last history row.
    // Avoid regressing the chart when profile.strength_score is stale vs history.
    if (profile && last && lastScoreValue !== current) {
      const profileAt = new Date(profile.updated_at || 0).getTime();
      const lastAt = new Date(last.recorded_at).getTime();
      if (!Number.isNaN(profileAt) && !Number.isNaN(lastAt) && profileAt > lastAt) {
        return [
          ...unique,
          {
            id: `current-${studentId}`,
            student_id: studentId,
            strength_score: current,
            recorded_at: profile.updated_at || new Date().toISOString(),
          },
        ];
      }
    }
    return unique;
  }

  if (error) {
    console.error('listStrengthHistory query error:', error.message);
  }

  const score = Math.round(Number(profile?.strength_score) || 0);
  if (!profile) return [];

  const synthetic = {
    id: `current-${studentId}`,
    student_id: studentId,
    strength_score: score,
    recorded_at: profile.updated_at || profile.created_at || new Date().toISOString(),
  };

  if (!error) {
    const { data: seeded, error: seedErr } = await supabaseAdmin
      .from('student_strength_history')
      .insert({
        student_id: studentId,
        strength_score: score,
        recorded_at: synthetic.recorded_at,
      })
      .select()
      .single();

    if (!seedErr && seeded) return [seeded];
    if (seedErr) console.error('listStrengthHistory seed error:', seedErr.message);
  }

  return [synthetic];
}
