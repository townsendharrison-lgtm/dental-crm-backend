/**
 * DAT dual-scale helpers (ADA concordance for Academic Average).
 *
 * - Legacy scale: 1–30
 * - Modern scale: 200–600 (10-point increments)
 *
 * Detection: score ≤ 30 → legacy; score > 30 → modern.
 * Strength score normalizes everything to a legacy AA equivalent (1–30).
 *
 * Keep in sync with frontend `lib/utils/datScale.ts`.
 */

/** Official ADA AA concordance: old (1–30) → new (200–600). */
export const DAT_AA_OLD_TO_NEW: Readonly<Record<number, number>> = {
  1: 200,
  2: 200,
  3: 210,
  4: 220,
  5: 220,
  6: 230,
  7: 240,
  8: 240,
  9: 250,
  10: 250,
  11: 260,
  12: 270,
  13: 290,
  14: 310,
  15: 330,
  16: 350,
  17: 370,
  18: 390,
  19: 410,
  20: 420,
  21: 440,
  22: 460,
  23: 470,
  24: 490,
  25: 510,
  26: 520,
  27: 540,
  28: 560,
  29: 580,
  30: 600,
};

export type DatScale = 'legacy' | 'modern';

export function detectDatScale(score: number): DatScale | null {
  if (!Number.isFinite(score) || score <= 0) return null;
  return score <= 30 ? 'legacy' : 'modern';
}

/** Convert any DAT AA/section score to legacy 1–30 equivalent (nearest AA concordance). */
export function normalizeDatToLegacy(score: number | null | undefined): number | null {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 30) return Math.round(n * 10) / 10;

  let bestOld = 1;
  let bestDist = Infinity;
  for (let old = 1; old <= 30; old++) {
    const neu = DAT_AA_OLD_TO_NEW[old];
    const dist = Math.abs(neu - n);
    if (dist < bestDist) {
      bestDist = dist;
      bestOld = old;
    }
  }
  return bestOld;
}

/** Convert legacy 1–30 → modern 200–600 via AA concordance. */
export function normalizeDatToModern(score: number | null | undefined): number | null {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 30) return Math.round(n);
  const old = Math.min(30, Math.max(1, Math.round(n)));
  return DAT_AA_OLD_TO_NEW[old] ?? null;
}
