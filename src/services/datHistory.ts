import { supabaseAdmin } from '../config/supabase.js';

export type DatSnapshot = {
  dat_score?: number | null;
  dat_aa?: number | null;
  dat_ts?: number | null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function changed(prev: DatSnapshot, next: DatSnapshot) {
  return (
    num(prev.dat_score) !== num(next.dat_score) ||
    num(prev.dat_aa) !== num(next.dat_aa) ||
    num(prev.dat_ts) !== num(next.dat_ts)
  );
}

function profileSnapshot(profile: {
  dat_score?: unknown;
  dat_aa?: unknown;
  dat_ts?: unknown;
  updated_at?: string | null;
  created_at?: string | null;
  id?: string;
}) {
  const snapshot = {
    dat_score: num(profile.dat_score),
    dat_aa: num(profile.dat_aa),
    dat_ts: num(profile.dat_ts),
  };

  if (snapshot.dat_score == null && snapshot.dat_aa == null && snapshot.dat_ts == null) {
    return null;
  }

  return {
    id: `current-${profile.id || 'profile'}`,
    student_id: profile.id,
    ...snapshot,
    recorded_at: profile.updated_at || profile.created_at || new Date().toISOString(),
    recorded_by: null,
  };
}

/** Insert a history row when DAT fields change. */
export async function recordDatHistoryIfChanged(
  studentId: string,
  previous: DatSnapshot,
  next: DatSnapshot,
  recordedBy?: string | null,
) {
  const snapshot = {
    dat_score: num(next.dat_score),
    dat_aa: num(next.dat_aa),
    dat_ts: num(next.dat_ts),
  };

  // Nothing to record if all null
  if (snapshot.dat_score == null && snapshot.dat_aa == null && snapshot.dat_ts == null) {
    return;
  }

  if (!changed(previous, snapshot)) return;

  const { error } = await supabaseAdmin.from('student_dat_history').insert({
    student_id: studentId,
    ...snapshot,
    recorded_by: recordedBy || null,
    recorded_at: new Date().toISOString(),
  });

  if (error) {
    console.error('recordDatHistoryIfChanged error:', error.message);
  }
}

/**
 * List DAT history ascending by time.
 * If empty / table missing but profile has a DAT score, return a snapshot so charts still work.
 */
export async function listDatHistory(studentId: string) {
  const { data: profile } = await supabaseAdmin
    .from('student_profiles')
    .select('id, dat_score, dat_aa, dat_ts, updated_at, created_at')
    .eq('id', studentId)
    .maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('student_dat_history')
    .select('*')
    .eq('student_id', studentId)
    .order('recorded_at', { ascending: true });

  if (!error && data && data.length > 0) return data;

  if (error) {
    console.error('listDatHistory query error:', error.message);
  }

  const synthetic = profile ? profileSnapshot(profile) : null;
  if (!synthetic) return [];

  // Best-effort seed into history table (ignored if migration not applied)
  if (!error) {
    const { data: seeded, error: seedErr } = await supabaseAdmin
      .from('student_dat_history')
      .insert({
        student_id: studentId,
        dat_score: synthetic.dat_score,
        dat_aa: synthetic.dat_aa,
        dat_ts: synthetic.dat_ts,
        recorded_at: synthetic.recorded_at,
      })
      .select()
      .single();

    if (!seedErr && seeded) return [seeded];
    if (seedErr) console.error('listDatHistory seed error:', seedErr.message);
  }

  return [synthetic];
}
