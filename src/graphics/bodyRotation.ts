/**
 * Orientamento dei corpi (solo grafica): polo IAU e meridiano fondamentale W(t).
 *
 * Fonte: IAU WGCCRE 2015 (Archinal et al. 2018), termini lineari (senza nutazioni/librazioni).
 *   W = W0 + Ẇ·d    d = giorni da J2000
 * Il meridiano fondamentale (longitudine 0) sta al centro delle mappe equirettangolari usate come
 * texture; per la Terra si usa il tempo siderale di Greenwich.
 * Le lune in rotazione sincrona senza dati IAU guardano sempre il pianeta (longitudine 0 verso di esso).
 *
 * Assi della mesh (SphereGeometry di Three.js): +Y = polo nord, +X = longitudine 0, −Z = 90° E.
 */
import * as THREE from 'three';
import { DAY, DEG, OBLIQUITY_J2000 } from '../physics/constants.ts';
import type { Simulation } from '../physics/simulation.ts';
import { ScaleManager } from './ScaleManager.ts';
import { applyMat3, temeToEclipticMatrix } from '../spacecraft/teme.ts';
import { Vec3 } from '../physics/vec3.ts';

const _tm = new Float64Array(3);
/**
 * Terra: stesso riferimento del simulatore di lancio e dei satelliti (TEME di data → eclittica J2000,
 * con la precessione): polo di data e meridiano di Greenwich dal tempo siderale.
 */
export function earthAxes(t: number): { pole: Vec3; lon0: Vec3 } {
  const M = temeToEclipticMatrix(t);
  applyMat3(M, 0, 0, 1, _tm);
  const pole = new Vec3(_tm[0], _tm[1], _tm[2]);
  const g = gmst(t);
  applyMat3(M, Math.cos(g), Math.sin(g), 0, _tm);
  return { pole, lon0: new Vec3(_tm[0], _tm[1], _tm[2]) };
}

interface Rot {
  W0: number;
  /** [°/giorno] */
  Wd: number;
}

const IAU: Record<string, Rot> = {
  sun: { W0: 84.176, Wd: 14.1844 },
  mercury: { W0: 329.5988, Wd: 6.1385108 },
  venus: { W0: 160.2, Wd: -1.4813688 },
  mars: { W0: 176.63, Wd: 350.89198226 },
  jupiter: { W0: 284.95, Wd: 870.536 },
  saturn: { W0: 38.9, Wd: 810.7939024 },
  uranus: { W0: 203.81, Wd: -501.1600928 },
  neptune: { W0: 249.978, Wd: 541.1397757 },
  pluto: { W0: 302.695, Wd: 56.3625225 },
  charon: { W0: 122.695, Wd: 56.3625225 },
};

/** Poli IAU delle lune (il catalogo fisico non li contiene). */
const MOON_POLES: Record<string, { ra: number; dec: number }> = {
  moon: { ra: 269.9949, dec: 66.5392 },
  phobos: { ra: 317.68, dec: 52.9 },
  deimos: { ra: 316.65, dec: 53.52 },
  io: { ra: 268.05, dec: 64.5 },
  europa: { ra: 268.08, dec: 64.51 },
  ganymede: { ra: 268.2, dec: 64.57 },
  callisto: { ra: 268.72, dec: 64.83 },
  titan: { ra: 39.4827, dec: 83.4279 },
  titania: { ra: 257.43, dec: -15.1 },
  oberon: { ra: 257.43, dec: -15.1 },
  triton: { ra: 299.36, dec: 41.17 },
  charon: { ra: 132.993, dec: -6.163 },
};

function poleOf(sim: Simulation, id: string): { ra: number; dec: number } | undefined {
  const b = sim.get(id);
  return b.def?.pole ?? MOON_POLES[id] ?? (b.parentId ? sim.get(b.parentId).def?.pole : undefined);
}

/** Fattore di schiacciamento polare (grafica): (R_eq − R_pol) / R_eq. */
export const FLATTENING: Record<string, number> = {
  earth: 0.00335,
  mars: 0.00589,
  jupiter: 0.06487,
  saturn: 0.09796,
  uranus: 0.0229,
  neptune: 0.0171,
};

/** Tempo siderale medio di Greenwich [rad] (IAU 1982) per t = secondi UTC da J2000. */
function gmst(t: number): number {
  const d = t / DAY;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T;
  return (((deg % 360) + 360) % 360) * DEG;
}

const cosE = Math.cos(OBLIQUITY_J2000);
const sinE = Math.sin(OBLIQUITY_J2000);

/** Vettore ICRF (equatoriale J2000) → assi di scena Three.js. */
function icrfToScene(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  // equatoriale → eclittica (rotazione attorno a X di +ε), poi eclittica → Three.js
  return ScaleManager.toThreeAxes(x, cosE * y + sinE * z, -sinE * y + cosE * z, out);
}

const _pole = new THREE.Vector3();
const _lon0 = new THREE.Vector3();
const _east = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _toParent = new THREE.Vector3();

/**
 * Orientamento del corpo in scena (quaternione da applicare alla mesh di raggio 1).
 * Restituisce false se il corpo non ha dati di polo.
 */
export function bodyOrientation(sim: Simulation, id: string, t: number, out: THREE.Quaternion): boolean {
  const b = sim.get(id);
  const pole = poleOf(sim, id);
  if (!pole) return false;
  const a = pole.ra * DEG;
  const d = pole.dec * DEG;
  const px = Math.cos(d) * Math.cos(a);
  const py = Math.cos(d) * Math.sin(a);
  const pz = Math.sin(d);
  icrfToScene(px, py, pz, _pole).normalize();

  if (id === 'earth') {
    const ax = earthAxes(t);
    ScaleManager.toThreeAxes(ax.pole.x, ax.pole.y, ax.pole.z, _pole).normalize();
    ScaleManager.toThreeAxes(ax.lon0.x, ax.lon0.y, ax.lon0.z, _lon0).normalize();
  } else if (b.def?.tidallyLocked && b.parentId && !IAU[id]) {
    // longitudine 0 rivolta verso il pianeta (proiettata sull'equatore del satellite)
    const rel = sim.position(b.parentId).sub(sim.position(id));
    ScaleManager.toThreeAxes(rel.x, rel.y, rel.z, _toParent).normalize();
    _lon0.copy(_toParent).addScaledVector(_pole, -_toParent.dot(_pole));
    if (_lon0.lengthSq() < 1e-12) return false;
    _lon0.normalize();
  } else {
    // nodo ascendente dell'equatore del corpo sull'equatore ICRF: Q = ẑ × p
    const W = id === 'earth' ? gmst(t) - Math.PI / 2 : ((IAU[id]?.W0 ?? 0) + (IAU[id]?.Wd ?? 360 / ((b.def?.rotationPeriod ?? 24) / 24)) * (t / DAY)) * DEG;
    const qx = -Math.sin(a);
    const qy = Math.cos(a);
    // p × Q
    const rx = py * 0 - pz * qy;
    const ry = pz * qx - px * 0;
    const rz = px * qy - py * qx;
    const c = Math.cos(W);
    const s = Math.sin(W);
    icrfToScene(c * qx + s * rx, c * qy + s * ry, s * rz, _lon0).normalize();
  }
  // base della mesh: X = lon 0, Y = polo, Z = X × Y (= −est)
  _east.crossVectors(_pole, _lon0); // 90° E
  _m.makeBasis(_lon0, _pole, _east.multiplyScalar(-1));
  out.setFromRotationMatrix(_m);
  return true;
}

/** Versore del polo nord in scena. */
export function bodyPole(sim: Simulation, id: string, out: THREE.Vector3): THREE.Vector3 | null {
  if (id === 'earth') {
    const p = earthAxes(sim.time).pole;
    return ScaleManager.toThreeAxes(p.x, p.y, p.z, out).normalize();
  }
  const pole = poleOf(sim, id);
  if (!pole) return null;
  const a = pole.ra * DEG;
  const d = pole.dec * DEG;
  return icrfToScene(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d), out).normalize();
}
