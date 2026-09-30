/**
 * JPL Horizons: costruzione delle richieste, parsing delle tabelle di vettori e
 * interpolazione di Hermite (posizione + velocità) fra i punti tabulati.
 *
 * Le effemeridi JPL delle sonde sono le traiettorie ufficiali (ricostruite dai dati di
 * tracciamento del Deep Space Network e, per il futuro prossimo, predette).
 * Frame richiesto: eclittica J2000 (REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF), unità km e km/s,
 * cioè lo stesso frame del motore fisico.
 */
import { DAY, J2000_JD } from '../physics/constants.ts';
import { Vec3 } from '../physics/vec3.ts';

/** Codici Horizons dei corpi centrali supportati. */
export const HORIZONS_CENTER: Record<string, string> = {
  sun: '500@10',
  earth: '500@399',
  moon: '500@301',
  mars: '500@499',
  jupiter: '500@599',
  saturn: '500@699',
};

export interface EphemPoint {
  /** Tempo di simulazione [s da J2000, TDB]. */
  t: number;
  /** Posizione [m] relativa al centro. */
  r: Vec3;
  /** Velocità [m/s]. */
  v: Vec3;
}

/**
 * Il tempo del simulatore deriva dall'orologio del computer (UTC), mentre Horizons usa TDB.
 * TDB − UTC = 32,184 s + 37 s intercalari = 69,184 s (costante dal 2017; TDB−TT < 2 ms).
 * Senza questa correzione la ISS risulterebbe spostata di ~530 km lungo l'orbita.
 */
export const TDB_MINUS_UTC = 69.184;

/** Data giuliana TDB → tempo di simulazione (secondi UTC da J2000). */
export const jdToSimTime = (jd: number) => (jd - J2000_JD) * DAY - TDB_MINUS_UTC;
/** Tempo di simulazione → data giuliana TDB (per le richieste a Horizons). */
export const simTimeToJd = (t: number) => (t + TDB_MINUS_UTC) / DAY + J2000_JD;

/** Parametri (già con gli apici richiesti da Horizons) per una tabella di vettori. */
export function horizonsVectorParams(opts: {
  command: string;
  center: string;
  startJd: number;
  stopJd: number;
  /** '1 d', '6 h', '10 m' … oppure un numero intero = numero di intervalli. */
  step: string;
}): Record<string, string> {
  return {
    COMMAND: `'${opts.command}'`,
    CENTER: `'${HORIZONS_CENTER[opts.center] ?? opts.center}'`,
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'",
    OBJ_DATA: "'NO'",
    START_TIME: `'JD ${opts.startJd.toFixed(6)}'`,
    STOP_TIME: `'JD ${opts.stopJd.toFixed(6)}'`,
    STEP_SIZE: `'${opts.step}'`,
    REF_PLANE: "'ECLIPTIC'",
    REF_SYSTEM: "'ICRF'",
    VEC_TABLE: "'2'",
    OUT_UNITS: "'KM-S'",
    CSV_FORMAT: "'YES'",
    VEC_LABELS: "'NO'",
  };
}

/** Estrae i punti fra $$SOE e $$EOE (CSV: JDTDB, data, X, Y, Z, VX, VY, VZ). */
export function parseHorizonsVectors(result: string): EphemPoint[] {
  const soe = result.indexOf('$$SOE');
  const eoe = result.indexOf('$$EOE');
  if (soe < 0 || eoe < 0) return [];
  const out: EphemPoint[] = [];
  for (const line of result.slice(soe + 5, eoe).split('\n')) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 8) continue;
    const n = [f[0], f[2], f[3], f[4], f[5], f[6], f[7]].map(Number);
    if (n.some((x) => !Number.isFinite(x))) continue;
    out.push({
      t: jdToSimTime(n[0]),
      r: new Vec3(n[1] * 1e3, n[2] * 1e3, n[3] * 1e3),
      v: new Vec3(n[4] * 1e3, n[5] * 1e3, n[6] * 1e3),
    });
  }
  return out;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Riconosce l'errore "No ephemeris for target ... prior to / after A.D. 1977-SEP-05 13:59:24.3830 TDB"
 * e restituisce il limite di copertura come data giuliana.
 */
export function parseCoverageLimit(message: string): { kind: 'prior' | 'after'; jd: number } | null {
  const m = /(prior to|after)\s+A\.D\.\s+(\d{4})-([A-Z]{3})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(message);
  if (!m) return null;
  const month = MONTHS[m[3].toUpperCase()];
  if (month === undefined) return null;
  const ms = Date.UTC(Number(m[2]), month, Number(m[4]), Number(m[5]), Number(m[6]), 0) + Number(m[7]) * 1000;
  return { kind: m[1].toLowerCase().startsWith('prior') ? 'prior' : 'after', jd: ms / 86400000 + 2440587.5 };
}

/** Effemeride tabulata con interpolazione di Hermite cubica. */
export class TabulatedEphemeris {
  readonly points: EphemPoint[];

  constructor(points: EphemPoint[]) {
    this.points = [...points].sort((a, b) => a.t - b.t);
  }

  get start(): number {
    return this.points.length ? this.points[0].t : NaN;
  }

  get end(): number {
    return this.points.length ? this.points[this.points.length - 1].t : NaN;
  }

  covers(t: number): boolean {
    return this.points.length >= 2 && t >= this.start && t <= this.end;
  }

  /** Stato interpolato al tempo t, oppure null se t è fuori dall'intervallo. */
  stateAt(t: number): { r: Vec3; v: Vec3 } | null {
    const p = this.points;
    if (!this.covers(t)) return null;
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return hermite(p[lo], p[hi], t);
  }

  /** Punto tabulato più vicino a t (per estrapolare fuori intervallo). */
  nearest(t: number): EphemPoint | null {
    if (!this.points.length) return null;
    return t <= this.start ? this.points[0] : this.points[this.points.length - 1];
  }
}

/** Interpolazione di Hermite cubica fra due stati (continua in posizione e velocità). */
export function hermite(a: EphemPoint, b: EphemPoint, t: number): { r: Vec3; v: Vec3 } {
  const h = b.t - a.t;
  if (h <= 0) return { r: a.r.clone(), v: a.v.clone() };
  const s = (t - a.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const r = a.r.scale(h00).add(a.v.scale(h10 * h)).add(b.r.scale(h01)).add(b.v.scale(h11 * h));
  const v = a.r.scale(d00 / h).add(a.v.scale(d10)).add(b.r.scale(d01 / h)).add(b.v.scale(d11));
  return { r, v };
}
