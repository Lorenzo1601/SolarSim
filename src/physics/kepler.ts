/**
 * Meccanica kepleriana a due corpi:
 *  - equazione di Keplero (ellittica e iperbolica) con Newton "protetto" da bisezione
 *  - elementi orbitali -> vettore di stato (posizione/velocità)
 *  - vettore di stato -> elementi orbitali osculanti (+ periapside, apoapside, periodo, energia)
 *  - campionamento della conica per il disegno delle orbite
 *
 * Convenzioni: angoli in radianti, a < 0 per le orbite iperboliche, μ = G(M+m) in m^3/s^2.
 */
import { TWO_PI, clamp, wrapAngle, wrapPi } from './constants.ts';
import { Vec3 } from './vec3.ts';

export interface OrbitalElements {
  /** Semiasse maggiore [m] (negativo se iperbolica). */
  a: number;
  /** Eccentricità. */
  e: number;
  /** Inclinazione [rad]. */
  i: number;
  /** Longitudine del nodo ascendente Ω [rad]. */
  raan: number;
  /** Argomento del periasse ω [rad]. */
  argp: number;
  /** Anomalia media M [rad] (iperbolica se e > 1). */
  M: number;
}

export interface StateVector {
  r: Vec3;
  v: Vec3;
}

export interface OrbitInfo extends OrbitalElements {
  /** Anomalia vera ν [rad]. */
  nu: number;
  /** Energia specifica ε = v²/2 − μ/r [J/kg]. */
  energy: number;
  /** Modulo del momento angolare specifico [m^2/s]. */
  h: number;
  /** Vettore momento angolare specifico (normale al piano orbitale). */
  hVec: Vec3;
  /** Vettore eccentricità (punta verso il periasse). */
  eVec: Vec3;
  /** Distanza di periasse dal centro del corpo primario [m]. */
  periapsis: number;
  /** Distanza di apoasse [m] (Infinity per orbite aperte). */
  apoapsis: number;
  /** Periodo orbitale [s] (Infinity per orbite aperte). */
  period: number;
  /** true se l'orbita è chiusa (ellittica). */
  isBound: boolean;
}

const MAX_ITER = 100;

/** Risolve M = E − e·sinE per 0 ≤ e < 1. */
export function solveKeplerElliptic(M: number, e: number): number {
  const m0 = wrapPi(M);
  const sgn = m0 < 0 ? -1 : 1;
  const m = Math.abs(m0);
  // La soluzione è nell'intervallo [m, m+e] ∩ [0, π]
  let lo = m;
  let hi = Math.min(Math.PI, m + e);
  let E = Math.min(hi, m + 0.85 * e); // stima iniziale di Danby
  for (let k = 0; k < MAX_ITER; k++) {
    const f = E - e * Math.sin(E) - m;
    if (f > 0) hi = E;
    else lo = E;
    let En = E - f / (1 - e * Math.cos(E));
    if (!(En > lo && En < hi)) En = 0.5 * (lo + hi);
    if (Math.abs(En - E) < 1e-15) {
      E = En;
      break;
    }
    E = En;
  }
  return sgn * E;
}

/** Risolve M = e·sinhH − H per e > 1. */
export function solveKeplerHyperbolic(M: number, e: number): number {
  const sgn = M < 0 ? -1 : 1;
  const m = Math.abs(M);
  let lo = 0;
  let hi = Math.asinh(m / (e - 1));
  let H = Math.asinh(m / e);
  for (let k = 0; k < MAX_ITER; k++) {
    const f = e * Math.sinh(H) - H - m;
    if (f > 0) hi = H;
    else lo = H;
    let Hn = H - f / (e * Math.cosh(H) - 1);
    if (!(Hn > lo && Hn < hi)) Hn = 0.5 * (lo + hi);
    if (Math.abs(Hn - H) < 1e-15 * Math.max(1, Math.abs(H))) {
      H = Hn;
      break;
    }
    H = Hn;
  }
  return sgn * H;
}

/** Versori P (verso il periasse) e Q (a 90° nel verso del moto) del piano orbitale. */
export function perifocalBasis(i: number, raan: number, argp: number): { P: Vec3; Q: Vec3; W: Vec3 } {
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const ci = Math.cos(i), si = Math.sin(i);
  const P = new Vec3(cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si);
  const Q = new Vec3(-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si);
  const W = new Vec3(sO * si, -cO * si, ci);
  return { P, Q, W };
}

/** Elementi orbitali -> posizione e velocità relative al corpo primario. */
export function elementsToState(el: OrbitalElements, mu: number): StateVector {
  const { e } = el;
  const { P, Q } = perifocalBasis(el.i, el.raan, el.argp);
  let x: number, y: number, vx: number, vy: number;

  if (e < 1) {
    const a = el.a;
    const E = solveKeplerElliptic(el.M, e);
    const cE = Math.cos(E), sE = Math.sin(E);
    const b = Math.sqrt(1 - e * e);
    const r = a * (1 - e * cE);
    const k = Math.sqrt(mu * a) / r;
    x = a * (cE - e);
    y = a * b * sE;
    vx = -k * sE;
    vy = k * b * cE;
  } else {
    const a = Math.abs(el.a);
    const H = solveKeplerHyperbolic(el.M, e);
    const cH = Math.cosh(H), sH = Math.sinh(H);
    const b = Math.sqrt(e * e - 1);
    const r = a * (e * cH - 1);
    const k = Math.sqrt(mu * a) / r;
    x = a * (e - cH);
    y = a * b * sH;
    vx = -k * sH;
    vy = k * b * cH;
  }

  return {
    r: P.scale(x).add(Q.scale(y)),
    v: P.scale(vx).add(Q.scale(vy)),
  };
}

/** Vettore di stato relativo -> elementi orbitali osculanti e grandezze derivate. */
export function stateToElements(r: Vec3, v: Vec3, mu: number): OrbitInfo {
  const rMag = r.length();
  const v2 = v.lengthSq();
  const rv = r.dot(v);
  const hVec = r.cross(v);
  const h = hVec.length();
  const nVec = new Vec3(-hVec.y, hVec.x, 0); // linea dei nodi
  const n = nVec.length();
  const eVec = r.scale(v2 - mu / rMag).sub(v.scale(rv)).scale(1 / mu);
  const e = eVec.length();
  const energy = v2 / 2 - mu / rMag;
  const a = energy !== 0 ? -mu / (2 * energy) : Infinity;
  const i = Math.acos(clamp(hVec.z / h, -1, 1));

  const equatorial = n < 1e-11 * h;
  const circular = e < 1e-10;
  const raan = equatorial ? 0 : wrapAngle(Math.atan2(nVec.y, nVec.x));
  let argp: number;
  let nu: number;

  if (!circular) {
    if (!equatorial) {
      argp = Math.acos(clamp(nVec.dot(eVec) / (n * e), -1, 1));
      if (eVec.z < 0) argp = TWO_PI - argp;
    } else {
      argp = Math.atan2(eVec.y, eVec.x);
      if (hVec.z < 0) argp = -argp;
      argp = wrapAngle(argp);
    }
    nu = Math.acos(clamp(eVec.dot(r) / (e * rMag), -1, 1));
    if (rv < 0) nu = TWO_PI - nu;
  } else {
    // Orbita circolare: periasse indefinito, si usa l'argomento della latitudine / longitudine vera
    argp = 0;
    if (!equatorial) {
      nu = Math.acos(clamp(nVec.dot(r) / (n * rMag), -1, 1));
      if (r.z < 0) nu = TWO_PI - nu;
    } else {
      nu = Math.atan2(r.y, r.x);
      if (hVec.z < 0) nu = -nu;
      nu = wrapAngle(nu);
    }
  }

  let M: number;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    M = wrapAngle(E - e * Math.sin(E));
  } else if (e > 1) {
    const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    M = e * Math.sinh(H) - H;
  } else {
    const D = Math.tan(nu / 2); // parabola: equazione di Barker
    M = D + (D * D * D) / 3;
  }

  const isBound = e < 1;
  return {
    a,
    e,
    i,
    raan,
    argp,
    M,
    nu,
    energy,
    h,
    hVec,
    eVec,
    periapsis: (h * h) / (mu * (1 + e)),
    apoapsis: isBound ? a * (1 + e) : Infinity,
    period: isBound ? TWO_PI * Math.sqrt((a * a * a) / mu) : Infinity,
    isBound,
  };
}

/** Velocità circolare a distanza r [m/s]. */
export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / r);
}

/** Velocità di fuga a distanza r [m/s]. */
export function escapeSpeed(mu: number, r: number): number {
  return Math.sqrt((2 * mu) / r);
}

/** Equazione vis-viva: velocità a distanza r su un'orbita di semiasse a [m/s]. */
export function visViva(mu: number, r: number, a: number): number {
  return Math.sqrt(mu * (2 / r - 1 / a));
}

/**
 * Punti della conica (relativi al primario) per il disegno dell'orbita.
 * Ellisse: `samples` punti chiusi. Iperbole: ramo limitato a r ≤ maxRadius.
 */
export function sampleOrbit(
  el: Pick<OrbitalElements, 'a' | 'e' | 'i' | 'raan' | 'argp'>,
  samples = 256,
  maxRadius = Infinity,
): Vec3[] {
  const { e } = el;
  const { P, Q } = perifocalBasis(el.i, el.raan, el.argp);
  const pts: Vec3[] = [];
  if (e < 1) {
    const a = el.a;
    const b = a * Math.sqrt(1 - e * e);
    for (let k = 0; k <= samples; k++) {
      const E = (k / samples) * TWO_PI;
      pts.push(P.scale(a * (Math.cos(E) - e)).add(Q.scale(b * Math.sin(E))));
    }
  } else {
    const p = Math.abs(el.a) * (e * e - 1); // semilato retto
    const nuInf = Math.acos(-1 / e);
    let nuMax = nuInf * 0.995;
    if (Number.isFinite(maxRadius)) {
      const c = (p / maxRadius - 1) / e;
      if (c > -1 && c < 1) nuMax = Math.min(nuMax, Math.acos(c));
    }
    for (let k = 0; k <= samples; k++) {
      const nu = -nuMax + (2 * nuMax * k) / samples;
      const r = p / (1 + e * Math.cos(nu));
      pts.push(P.scale(r * Math.cos(nu)).add(Q.scale(r * Math.sin(nu))));
    }
  }
  return pts;
}

/**
 * Propagazione kepleriana a due corpi: stato (r, v) → stato dopo dt secondi.
 * Usata per estrapolare le traiettorie delle sonde fuori dagli intervalli tabulati.
 */
export function propagateKepler(r: Vec3, v: Vec3, mu: number, dt: number): StateVector {
  const o = stateToElements(r, v, mu);
  const aAbs = Math.abs(o.a);
  if (!Number.isFinite(aAbs) || Math.abs(o.e - 1) < 1e-9) {
    return { r: r.add(v.scale(dt)), v: v.clone() }; // caso degenere (parabolico): moto rettilineo
  }
  const n = Math.sqrt(mu / (aAbs * aAbs * aAbs));
  return elementsToState({ a: o.a, e: o.e, i: o.i, raan: o.raan, argp: o.argp, M: o.M + n * dt }, mu);
}
