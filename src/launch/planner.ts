/**
 * Pianificazione di missione:
 *  - problema di Lambert (variabili universali) per i trasferimenti interplanetari;
 *  - "porkchop plot": ricerca della finestra di lancio (data di partenza e durata del viaggio)
 *    che minimizza l'energia di lancio C3 (e la frenata all'arrivo, per l'inserimento in orbita);
 *  - ora di lancio nella giornata: il piano dell'orbita di parcheggio deve contenere la direzione
 *    di partenza (asintoto iperbolico) o la posizione della Luna all'arrivo;
 *  - inclinazione eliosincrona (SSO).
 */
import type { BodyDef } from '../data/bodies.ts';
import { propagateKepler } from '../physics/kepler.ts';
import type { Simulation } from '../physics/simulation.ts';
import { DAY } from '../physics/constants.ts';
import { keplerianSystemState } from '../physics/initialState.ts';
import { Vec3 } from '../physics/vec3.ts';
import { applyMat3, temeToEclipticMatrix, type Mat3 } from '../spacecraft/teme.ts';
import { launchAzimuth } from './ascent.ts';
import { J2_EARTH, MU_EARTH, R_EQ, geodeticToEcef, gmst, rotZ } from './earthModel.ts';
import type { LaunchSite } from './rockets.ts';

export const MU_SUN = 1.32712440041279e20;

// ───────────────────────── Lambert ─────────────────────────

function stumpffC(z: number): number {
  if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24;
}

function stumpffS(z: number): number {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120;
}

/**
 * Problema di Lambert (singola rivoluzione): velocità in r1 e r2 per andare da r1 a r2 in `tof` secondi.
 * `prograde` riferito al piano xy del frame (eclittica).
 */
export function lambert(r1: Vec3, r2: Vec3, tof: number, mu: number, prograde = true): { v1: Vec3; v2: Vec3 } | null {
  const R1 = r1.length();
  const R2 = r2.length();
  const cross = r1.cross(r2);
  let dth = Math.acos(Math.max(-1, Math.min(1, r1.dot(r2) / (R1 * R2))));
  if (prograde ? cross.z < 0 : cross.z >= 0) dth = 2 * Math.PI - dth;
  const A = Math.sin(dth) * Math.sqrt((R1 * R2) / (1 - Math.cos(dth)));
  if (!Number.isFinite(A) || Math.abs(A) < 1e-9) return null;
  const y = (z: number) => R1 + R2 + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const F = (z: number) => {
    const yz = y(z);
    if (yz < 0) return -Infinity;
    return Math.pow(yz / stumpffC(z), 1.5) * stumpffS(z) + A * Math.sqrt(yz) - Math.sqrt(mu) * tof;
  };
  let lo = -4 * Math.PI * Math.PI;
  let hi = 4 * Math.PI * Math.PI - 1e-6;
  // allarga verso le iperboli se serve
  while (F(lo) > 0 && lo > -1e4) lo *= 2;
  if (F(lo) > 0 || F(hi) < 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const f = F(mid);
    if (f > 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  const z = 0.5 * (lo + hi);
  const yz = y(z);
  const f = 1 - yz / R1;
  const g = A * Math.sqrt(yz / mu);
  const gdot = 1 - yz / R2;
  return { v1: r2.sub(r1.scale(f)).scale(1 / g), v2: r2.scale(gdot).sub(r1).scale(1 / g) };
}

// ───────────────────────── Finestre interplanetarie ─────────────────────────

export interface TransferPlan {
  target: string;
  departure: number;
  arrival: number;
  /** Velocità di eccesso iperbolico in partenza (eliocentrica, eclittica) [m/s]. */
  vInfDep: Vec3;
  vInfArr: Vec3;
  c3: number;
  /** Declinazione dell'asintoto di partenza rispetto all'equatore terrestre [rad]. */
  dla: number;
  /** Δv stimati: fuga da LEO 200 km e cattura (orbita ellittica) all'arrivo [m/s]. */
  dvDeparture: number;
  dvCapture: number;
}

export const TRANSFER_RANGES: Record<string, { tof: [number, number]; label: string }> = {
  mercury: { tof: [80, 220], label: 'Mercurio' },
  venus: { tof: [90, 220], label: 'Venere' },
  mars: { tof: [140, 360], label: 'Marte' },
  jupiter: { tof: [500, 1150], label: 'Giove' },
  saturn: { tof: [1000, 2600], label: 'Saturno' },
  uranus: { tof: [2500, 5500], label: 'Urano' },
  neptune: { tof: [3500, 7000], label: 'Nettuno' },
};

/** Declinazione di un vettore eclittico rispetto all'equatore (J2000). */
export function declinationOf(v: Vec3): number {
  const eps = (23.4392911 * Math.PI) / 180;
  const z = -Math.sin(eps) * v.y + Math.cos(eps) * v.z;
  return Math.asin(Math.max(-1, Math.min(1, z / v.length())));
}

/**
 * Ricerca della finestra di lancio verso un pianeta (Lambert su effemeridi kepleriane).
 * `insertion`: se vero minimizza anche la frenata all'arrivo.
 */
export function searchTransfer(
  catalog: readonly BodyDef[],
  target: string,
  fromTime: number,
  spanDays: number,
  insertion: boolean,
  captureAltitude: number,
): TransferPlan | null {
  const earth = catalog.find((b) => b.id === 'earth')!;
  const planet = catalog.find((b) => b.id === target);
  const range = TRANSFER_RANGES[target];
  if (!planet || !range) return null;
  const muP = catalog.filter((b) => b.id === target || b.parent === target).reduce((s, b) => s + b.gm, 0);
  const rpP = planet.radius + captureAltitude;
  const rpE = R_EQ + 200e3;
  const depStep = Math.max(2, spanDays / 250) * DAY;
  const tofSteps = 40;
  let best: TransferPlan | null = null;
  let bestCost = Infinity;
  const evalAt = (tDep: number, tof: number) => {
    const e = keplerianSystemState(catalog, earth, tDep);
    const p = keplerianSystemState(catalog, planet, tDep + tof);
    const sol = lambert(e.r, p.r, tof, MU_SUN, true);
    if (!sol) return;
    const vInfDep = sol.v1.sub(e.v);
    const vInfArr = sol.v2.sub(p.v);
    const c3 = vInfDep.lengthSq();
    const dvDep = Math.sqrt(c3 + (2 * MU_EARTH) / rpE) - Math.sqrt(MU_EARTH / rpE);
    const vArr = vInfArr.lengthSq();
    // cattura in un'orbita ellittica con apoasse a 20 raggi planetari
    const rA = planet.radius * 20;
    const vpEll = Math.sqrt((2 * muP * rA) / (rpP * (rpP + rA)));
    const dvCap = Math.sqrt(vArr + (2 * muP) / rpP) - vpEll;
    const cost = dvDep + (insertion ? dvCap : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = {
        target, departure: tDep, arrival: tDep + tof, vInfDep, vInfArr, c3, dla: declinationOf(vInfDep),
        dvDeparture: dvDep, dvCapture: dvCap,
      };
    }
  };
  for (let tDep = fromTime; tDep <= fromTime + spanDays * DAY; tDep += depStep) {
    for (let k = 0; k <= tofSteps; k++) {
      const tof = (range.tof[0] + ((range.tof[1] - range.tof[0]) * k) / tofSteps) * DAY;
      evalAt(tDep, tof);
    }
  }
  // raffinamento locale
  if (best) {
    const b0 = best as TransferPlan;
    const tofB = b0.arrival - b0.departure;
    for (let dd = -depStep; dd <= depStep; dd += depStep / 8) {
      for (let dt = -0.04; dt <= 0.04; dt += 0.005) evalAt(b0.departure + dd, tofB * (1 + dt));
    }
  }
  return best;
}

// ───────────────────────── Piano di parcheggio e ora di lancio ─────────────────────────

/** Normale (ECI) del piano orbitale ottenuto lanciando al tempo t con inclinazione i. */
export function parkingPlaneNormal(site: LaunchSite, t: number, incl: number, southward: boolean): Vec3 {
  const r = rotZ(geodeticToEcef(site.lat, site.lon, site.alt), gmst(t)).normalize();
  const az = launchAzimuth((site.lat * Math.PI) / 180, incl, 7800, southward);
  const east = new Vec3(0, 0, 1).cross(r).normalize();
  const north = r.cross(east);
  const d = east.scale(Math.sin(az.inertial)).add(north.scale(Math.cos(az.inertial)));
  return r.cross(d).normalize();
}

/** Vettore eclittico → ECI della data (trasposta di TEME→eclittica). */
export function eclipticToEci(v: Vec3, M: Mat3): Vec3 {
  return new Vec3(
    M[0] * v.x + M[3] * v.y + M[6] * v.z,
    M[1] * v.x + M[4] * v.y + M[7] * v.z,
    M[2] * v.x + M[5] * v.y + M[8] * v.z,
  );
}

export function eciToEcliptic(v: Vec3, M: Mat3): Vec3 {
  const out = [0, 0, 0];
  applyMat3(M, v.x, v.y, v.z, out);
  return new Vec3(out[0], out[1], out[2]);
}

/**
 * Trova l'istante di lancio (fra `from` e `from + span`) in cui il piano di parcheggio contiene
 * la direzione `dirAt(t)` (eclittica). Prova sia l'azimut verso nord sia verso sud.
 */
export function findPlaneWindow(
  site: LaunchSite,
  incl: number,
  from: number,
  span: number,
  dirAt: (tLaunch: number) => Vec3,
): { t: number; southward: boolean; error: number } {
  let best = { t: from, southward: false, error: Infinity };
  for (const southward of [false, true]) {
    for (let t = from; t <= from + span; t += 60) {
      const M = temeToEclipticMatrix(t);
      const d = eclipticToEci(dirAt(t), M).normalize();
      const err = Math.abs(d.dot(parkingPlaneNormal(site, t, incl, southward)));
      if (err < best.error) best = { t, southward, error: err };
    }
  }
  return best;
}

/** Inclinazione eliosincrona per un'orbita circolare di quota h [rad]. */
export function ssoInclination(h: number): number {
  const a = R_EQ + h;
  const rate = (2 * Math.PI) / (365.2422 * DAY); // precessione nodale richiesta
  const cosI = -(rate * Math.pow(a, 3.5)) / (1.5 * J2_EARTH * R_EQ * R_EQ * Math.sqrt(MU_EARTH));
  return Math.acos(Math.max(-1, Math.min(1, cosI)));
}

/**
 * Finestra di lancio lunare: istante (entro `span`) in cui il piano di parcheggio contiene la
 * posizione che la Luna avrà all'arrivo (~3,5 giorni dopo la TLI).
 */
export function lunarWindow(sim: Simulation, site: LaunchSite, incl: number, from: number, span = DAY): { t: number; southward: boolean; error: number } {
  const moon = sim.get('moon');
  const earth = sim.get('earth');
  const r0 = sim.position('moon').sub(sim.position('earth'));
  const v0 = sim.velocity('moon').sub(sim.velocity('earth'));
  const mu = moon.gm + earth.gm;
  return findPlaneWindow(site, incl, from, span, (tL) => propagateKepler(r0, v0, mu, tL - sim.time + 3.6 * DAY).r);
}

/**
 * Velocità richiesta nel punto `r` per trovarsi su un'iperbole di fuga con velocità asintotica `vInf`
 * (stesso verso di moto di `hOrb`). Usata dalla guida "velocità da guadagnare" durante l'iniezione:
 * il motore spinge lungo (v_richiesta − v) finché la differenza si annulla, compensando così le
 * perdite di una lunga combustione finita e l'eventuale piccolo cambio di piano.
 */
export function hyperbolicVelocity(r: Vec3, vInf: Vec3, mu: number, hOrb: Vec3): Vec3 | null {
  const rr = r.length();
  const vi = vInf.length();
  if (rr === 0 || vi === 0) return null;
  const rh = r.scale(1 / rr);
  const s = vInf.scale(1 / vi);
  let n = rh.cross(s);
  if (n.length() < 0.02) n = hOrb.normalize();
  else {
    n = n.normalize();
    if (n.dot(hOrb) < 0) n = n.scale(-1);
  }
  // angolo da r̂ all'asintoto, misurato nel verso del moto
  let theta = Math.atan2(n.dot(rh.cross(s)), rh.dot(s));
  if (theta <= 0) theta += 2 * Math.PI;
  const lo0 = Math.max(Math.PI / 2, theta / 2) + 1e-9;
  if (lo0 >= Math.PI) return null;
  const radiusAt = (nuInf: number) => {
    const e = -1 / Math.cos(nuInf);
    const p = (mu * (e * e - 1)) / (vi * vi);
    const nu = nuInf - theta;
    const den = 1 + e * Math.cos(nu);
    return { e, p, nu, r: den > 0 ? p / den : Infinity };
  };
  // r(ν∞) cresce al diminuire di ν∞: bisezione
  let lo = lo0;
  let hi = Math.PI - 1e-9;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (radiusAt(mid).r > rr) lo = mid;
    else hi = mid;
  }
  const { e, p, nu } = radiusAt((lo + hi) / 2);
  const k = Math.sqrt(mu / p);
  const t = n.cross(rh);
  return rh.scale(k * e * Math.sin(nu)).add(t.scale(k * (1 + e * Math.cos(nu))));
}
