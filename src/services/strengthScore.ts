/**
 * Strength score (0–100) — automatic competitiveness index.
 * Weighted from academics, DAT, clinical/experience hours, docs, and application readiness.
 */

export type StrengthScoreInputs = {
  gpa?: number | null;
  datAa?: number | null;
  datScore?: number | null;
  datVerified?: boolean | null;
  hoursByCategory?: Partial<Record<string, number>>;
  documentTypes?: string[];
  lorRequired?: number | null;
  lorReceivedApprox?: number | null;
  applicationCount?: number | null;
  schoolCount?: number | null;
  isReapplicant?: boolean | null;
};

export type StrengthScoreBreakdown = {
  total: number;
  academics: number;
  dat: number;
  experience: number;
  documents: number;
  readiness: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function scale(value: number, fromMin: number, fromMax: number, toMax: number) {
  if (value <= fromMin) return 0;
  if (value >= fromMax) return toMax;
  return ((value - fromMin) / (fromMax - fromMin)) * toMax;
}

function hours(map: Partial<Record<string, number>> | undefined, key: string) {
  return Number(map?.[key] || 0);
}

/** Pure formula — keep in sync with frontend `lib/utils/strengthScore.ts`. */
export function calculateStrengthScore(input: StrengthScoreInputs): StrengthScoreBreakdown {
  // Academics — max 25 (GPA 3.0→0 … 4.0→25)
  const gpa = Number(input.gpa);
  const academics = Number.isFinite(gpa) ? Math.round(scale(gpa, 3.0, 4.0, 25)) : 0;

  // DAT — max 30 (prefer AA; fallback overall). 17→0 … 25→30
  const dat = Number(input.datAa ?? input.datScore);
  let datPts = Number.isFinite(dat) ? Math.round(scale(dat, 17, 25, 30)) : 0;
  if (input.datVerified && datPts > 0) {
    datPts = Math.min(30, datPts + 2);
  }

  // Experience hours — max 25
  const h = input.hoursByCategory || {};
  const shadowing = Math.round(scale(hours(h, 'Shadowing'), 0, 100, 8));
  const volunteering = Math.round(scale(hours(h, 'Volunteering'), 0, 100, 6));
  const dental = Math.round(scale(hours(h, 'Dental Experience'), 0, 80, 6));
  const research = Math.round(scale(hours(h, 'Research'), 0, 100, 5));
  const experience = clamp(shadowing + volunteering + dental + research, 0, 25);

  // Documents — max 10
  const types = new Set((input.documentTypes || []).map((t) => String(t)));
  let documents = 0;
  if (types.has('DAT Report')) documents += 4;
  if (types.has('Transcript') || types.has('Post-Bac Transcript')) documents += 3;
  if (types.has('Resume')) documents += 2;
  if (types.has('Letter of Recommendation')) documents += 1;
  documents = clamp(documents, 0, 10);

  // Application readiness — max 10
  let readiness = 0;
  const apps = Number(input.applicationCount || 0);
  const schools = Number(input.schoolCount || 0);
  if (apps > 0 || schools > 0) readiness += 4;
  if (apps >= 5 || schools >= 5) readiness += 2;

  const lorRequired = Number(input.lorRequired ?? 4) || 4;
  const lorGot = Number(input.lorReceivedApprox || 0);
  readiness += Math.round(scale(lorGot, 0, lorRequired, 4));

  // Mild reapplicant penalty if no compensating DAT yet
  if (input.isReapplicant && (!Number.isFinite(dat) || dat < 20)) {
    readiness = Math.max(0, readiness - 2);
  }
  readiness = clamp(readiness, 0, 10);

  const total = clamp(academics + datPts + experience + documents + readiness, 0, 100);

  return {
    total,
    academics,
    dat: datPts,
    experience,
    documents,
    readiness,
  };
}
