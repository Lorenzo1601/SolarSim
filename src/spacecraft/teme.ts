/**
 * Conversione TEME (output di SGP4) → eclittica J2000 (frame del motore fisico).
 *
 * SGP4 restituisce posizioni nel frame TEME ("True Equator, Mean Equinox" della data).
 * Lo approssimiamo con l'equatore medio della data e applichiamo la precessione IAU 1976
 * all'indietro fino a J2000, poi la rotazione equatoriale → eclittica.
 * Si trascura la nutazione (≤ ~20″): errore di pochi km in LEO/GEO, invisibile a video.
 */
import { DEG, JULIAN_CENTURY, OBLIQUITY_J2000 } from '../physics/constants.ts';

/** Matrice 3×3 in ordine riga-maggiore. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const ARCSEC = DEG / 3600;

/** Matrice di precessione P (IAU 1976, Lieske): r_dataMedia = P · r_J2000. t = secondi da J2000. */
export function precessionMatrix(t: number): Mat3 {
  const T = t / JULIAN_CENTURY;
  const T2 = T * T;
  const T3 = T2 * T;
  const zeta = (2306.2181 * T + 0.30188 * T2 + 0.017998 * T3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T2 + 0.018203 * T3) * ARCSEC;
  const th = (2004.3109 * T - 0.42665 * T2 - 0.041833 * T3) * ARCSEC;
  const cze = Math.cos(zeta), sze = Math.sin(zeta);
  const cz = Math.cos(z), sz = Math.sin(z);
  const ct = Math.cos(th), st = Math.sin(th);
  return [
    cz * ct * cze - sz * sze, -cz * ct * sze - sz * cze, -cz * st,
    sz * ct * cze + cz * sze, -sz * ct * sze + cz * cze, -sz * st,
    st * cze, -st * sze, ct,
  ];
}

/** Matrice unica TEME(data) → eclittica J2000:  M = E · Pᵀ. */
export function temeToEclipticMatrix(t: number): Mat3 {
  const P = precessionMatrix(t);
  const c = Math.cos(OBLIQUITY_J2000);
  const s = Math.sin(OBLIQUITY_J2000);
  // Pᵀ: righe di Pᵀ = colonne di P
  const r0 = [P[0], P[3], P[6]];
  const r1 = [P[1], P[4], P[7]];
  const r2 = [P[2], P[5], P[8]];
  return [
    r0[0], r0[1], r0[2],
    c * r1[0] + s * r2[0], c * r1[1] + s * r2[1], c * r1[2] + s * r2[2],
    -s * r1[0] + c * r2[0], -s * r1[1] + c * r2[1], -s * r1[2] + c * r2[2],
  ];
}

/** out[o..o+2] = M · (x, y, z) */
export function applyMat3(M: Mat3, x: number, y: number, z: number, out: { [k: number]: number }, o = 0): void {
  out[o] = M[0] * x + M[1] * y + M[2] * z;
  out[o + 1] = M[3] * x + M[4] * y + M[5] * z;
  out[o + 2] = M[6] * x + M[7] * y + M[8] * z;
}
