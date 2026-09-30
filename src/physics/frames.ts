/**
 * Sistemi di riferimento.
 * Frame inerziale del motore: eclittica e equinozio J2000, origine nel baricentro del Sistema Solare.
 *   +X verso il punto vernale, +Z verso il polo nord dell'eclittica.
 */
import { DEG, OBLIQUITY_J2000 } from './constants.ts';
import { Vec3 } from './vec3.ts';

export interface Basis {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** Equatoriale ICRF/J2000 -> eclittica J2000 (rotazione attorno a X di +ε). */
export function equatorialToEcliptic(v: Vec3): Vec3 {
  const c = Math.cos(OBLIQUITY_J2000);
  const s = Math.sin(OBLIQUITY_J2000);
  return new Vec3(v.x, c * v.y + s * v.z, -s * v.y + c * v.z);
}

/** Versore del polo nord di un corpo (ascensione retta/declinazione IAU in gradi) in coordinate eclittiche. */
export function poleVectorEcliptic(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  return equatorialToEcliptic(
    new Vec3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)),
  );
}

/**
 * Base ortonormale del piano equatoriale di un corpo, espressa nel frame eclittico:
 *   z = polo del corpo, x = nodo ascendente dell'equatore sull'eclittica, y = z × x.
 * Serve a posizionare le orbite delle lune, definite rispetto all'equatore del pianeta.
 */
export function equatorialBasis(raDeg: number, decDeg: number): Basis {
  const z = poleVectorEcliptic(raDeg, decDeg);
  let x = new Vec3(0, 0, 1).cross(z);
  x = x.length() < 1e-12 ? new Vec3(1, 0, 0) : x.normalize();
  const y = z.cross(x);
  return { x, y, z };
}

/** Trasforma un vettore espresso nella base `b` nel frame eclittico. */
export function fromBasis(b: Basis, v: Vec3): Vec3 {
  return b.x.scale(v.x).add(b.y.scale(v.y)).add(b.z.scale(v.z));
}
