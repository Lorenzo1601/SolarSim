/**
 * Costanti fisiche/astronomiche e utilità sul tempo.
 * Unità interne del motore: SI (metri, chilogrammi, secondi, radianti).
 * Il tempo di simulazione è espresso in secondi dall'epoca J2000.0, derivato dall'orologio UTC.
 * La differenza con TDB (~69 s) è trascurabile per i pianeti e viene corretta dove conta
 * (effemeridi JPL delle sonde: vedi spacecraft/horizons.ts).
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TWO_PI = 2 * Math.PI;

/** Costante di gravitazione universale [m^3 kg^-1 s^-2] (CODATA 2018). */
export const G = 6.6743e-11;
/** Unità astronomica [m] (IAU 2012, valore esatto). */
export const AU = 1.495978707e11;
export const KM = 1e3;
/** Fattore di conversione km^3/s^2 -> m^3/s^2 (i GM sono tabulati in km^3/s^2). */
export const KM3S2 = 1e9;

export const DAY = 86400;
export const JULIAN_YEAR = 365.25 * DAY;
export const JULIAN_CENTURY = 36525 * DAY;

/** Data giuliana dell'epoca J2000.0 (2000-01-01 12:00 TT). */
export const J2000_JD = 2451545.0;
/** Data giuliana di 1970-01-01 00:00 UTC. */
export const UNIX_EPOCH_JD = 2440587.5;
/** Obliquità dell'eclittica a J2000 (IAU 2006). */
export const OBLIQUITY_J2000 = 23.4392911 * DEG;

/** Data -> data giuliana (UTC; la differenza TT-UTC di ~69 s è trascurata). */
export function jdFromDate(date: Date): number {
  return date.getTime() / 86400000 + UNIX_EPOCH_JD;
}

/** Data -> secondi da J2000. */
export function simTimeFromDate(date: Date): number {
  return (jdFromDate(date) - J2000_JD) * DAY;
}

/** Secondi da J2000 -> Date JavaScript. */
export function dateFromSimTime(t: number): Date {
  return new Date((t / DAY + J2000_JD - UNIX_EPOCH_JD) * 86400000);
}

/** Riporta un angolo in [0, 2π). */
export function wrapAngle(x: number): number {
  const r = x % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

/** Riporta un angolo in (-π, π]. */
export function wrapPi(x: number): number {
  const r = wrapAngle(x);
  return r > Math.PI ? r - TWO_PI : r;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
