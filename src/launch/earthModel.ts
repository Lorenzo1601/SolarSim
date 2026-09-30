/**
 * Modello della Terra per il lancio: costanti WGS-84, coordinate geodetiche, rotazione (GMST),
 * perturbazione J2. Frame inerziale di lancio "ECI" = equatore e equinozio della data
 * (lo stesso di SGP4/TEME), convertito nel frame del motore con temeToEclipticMatrix.
 */
import { gstime } from 'satellite.js';
import { dateFromSimTime } from '../physics/constants.ts';
import { Vec3 } from '../physics/vec3.ts';

export const MU_EARTH = 3.986004418e14;
export const R_EQ = 6378137;
export const F_EARTH = 1 / 298.257223563;
export const E2_EARTH = F_EARTH * (2 - F_EARTH);
export const J2_EARTH = 1.08262668e-3;
export const OMEGA_EARTH = 7.2921159e-5;
export const G0 = 9.80665;
/** Raggio della geostazionaria [m]. */
export const R_GEO = 42164e3;

/** Tempo siderale di Greenwich [rad] al tempo di simulazione t. */
export function gmst(t: number): number {
  return gstime(dateFromSimTime(t));
}

/** Geodetiche (gradi, metri) → ECEF [m]. */
export function geodeticToEcef(latDeg: number, lonDeg: number, h: number): Vec3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const N = R_EQ / Math.sqrt(1 - E2_EARTH * Math.sin(lat) ** 2);
  return new Vec3(
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - E2_EARTH) + h) * Math.sin(lat),
  );
}

/** ECEF → geodetiche (gradi, gradi, metri), metodo iterativo. */
export function ecefToGeodetic(p: Vec3): { lat: number; lon: number; h: number } {
  const lon = Math.atan2(p.y, p.x);
  const rho = Math.hypot(p.x, p.y);
  let lat = Math.atan2(p.z, rho * (1 - E2_EARTH));
  let h = 0;
  for (let k = 0; k < 6; k++) {
    const N = R_EQ / Math.sqrt(1 - E2_EARTH * Math.sin(lat) ** 2);
    h = Math.abs(Math.cos(lat)) > 1e-9 ? rho / Math.cos(lat) - N : Math.abs(p.z) - N * (1 - E2_EARTH);
    lat = Math.atan2(p.z, rho * (1 - (E2_EARTH * N) / (N + h)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, h };
}

/** Rotazione attorno all'asse z (ECEF ↔ ECI). */
export function rotZ(p: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return new Vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

/** Velocità del suolo (rotazione terrestre) in un punto ECI: ω × r. */
export function groundVelocity(r: Vec3): Vec3 {
  return new Vec3(-OMEGA_EARTH * r.y, OMEGA_EARTH * r.x, 0);
}

/** Quota geodetica approssimata (ellissoide) da una posizione ECI. */
export function altitudeOf(r: Vec3): number {
  const rr = r.length();
  const sinLat = r.z / rr;
  // raggio dell'ellissoide alla latitudine geocentrica
  const Re = R_EQ * (1 - F_EARTH * sinLat * sinLat);
  return rr - Re;
}

/** Accelerazione J2 in un frame con asse z = asse di rotazione terrestre. */
export function j2Accel(r: Vec3, mu = MU_EARTH): Vec3 {
  const r2 = r.lengthSq();
  const rr = Math.sqrt(r2);
  const zr2 = (r.z * r.z) / r2;
  const k = (-1.5 * J2_EARTH * mu * R_EQ * R_EQ) / (r2 * r2 * rr);
  return new Vec3(k * r.x * (1 - 5 * zr2), k * r.y * (1 - 5 * zr2), k * r.z * (3 - 5 * zr2));
}
