/**
 * Condizioni iniziali: dagli elementi del catalogo ai vettori di stato baricentrici a un istante t.
 *
 * Procedura:
 *  1. per ogni pianeta, gli elementi di Standish descrivono l'orbita eliocentrica del BARICENTRO del
 *     sistema pianeta+lune (per la Terra è esattamente il baricentro Terra–Luna);
 *  2. le lune vengono posizionate rispetto al pianeta e poi pianeta+lune vengono traslati in modo che
 *     il loro baricentro coincida con il punto calcolato al passo 1;
 *  3. infine tutto viene riferito al baricentro del Sistema Solare (quantità di moto totale nulla),
 *     così la simulazione non "deriva" nello spazio.
 */
import type { BodyDef } from '../data/bodies.ts';
import { AU, DAY, DEG, J2000_JD, JULIAN_CENTURY, KM, wrapAngle } from './constants.ts';
import { equatorialBasis, fromBasis } from './frames.ts';
import { elementsToState, type OrbitalElements, type StateVector } from './kepler.ts';
import { Vec3 } from './vec3.ts';

export interface InitialBodyState {
  def: BodyDef;
  r: Vec3;
  v: Vec3;
}

/** Lune di un corpo presenti nel catalogo. */
export function moonsOf(catalog: readonly BodyDef[], parentId: string): BodyDef[] {
  return catalog.filter((b) => b.parent === parentId && b.moonElements);
}

/** GM totale del sistema pianeta + lune. */
export function systemGM(catalog: readonly BodyDef[], def: BodyDef): number {
  return moonsOf(catalog, def.id).reduce((s, m) => s + m.gm, def.gm);
}

/** Elementi eliocentrici del baricentro di un sistema planetario al tempo t [s da J2000]. */
export function planetOrbitalElements(def: BodyDef, t: number): OrbitalElements {
  const p = def.planetElements;
  if (!p) throw new Error(`${def.id}: elementi planetari mancanti`);
  const T = t / JULIAN_CENTURY;
  const node = (p.node + p.nodeDot * T) * DEG;
  const varpi = (p.varpi + p.varpiDot * T) * DEG;
  const L = (p.L + p.LDot * T) * DEG;
  return {
    a: (p.a + p.aDot * T) * AU,
    e: p.e + p.eDot * T,
    i: (p.I + p.IDot * T) * DEG,
    raan: wrapAngle(node),
    argp: wrapAngle(varpi - node),
    M: wrapAngle(L - varpi),
  };
}

/** Elementi di una luna rispetto al pianeta al tempo t (nel piano di riferimento della luna). */
export function moonOrbitalElements(def: BodyDef, parentGM: number, t: number): OrbitalElements {
  const m = def.moonElements;
  if (!m) throw new Error(`${def.id}: elementi lunari mancanti`);
  const d = t / DAY + J2000_JD - (m.epochJD ?? J2000_JD); // giorni dall'epoca degli elementi
  const a = m.a * KM;
  const mu = parentGM + def.gm;
  const nDegPerDay = m.meanMotion ?? (Math.sqrt(mu / (a * a * a)) * DAY) / DEG;
  return {
    a,
    e: m.e,
    i: m.i * DEG,
    raan: wrapAngle((m.node + (m.nodeRate ?? 0) * d) * DEG),
    argp: wrapAngle((m.argp + (m.argpRate ?? 0) * d) * DEG),
    M: wrapAngle((m.M0 + nDegPerDay * d) * DEG),
  };
}

/** Stato di una luna relativo al pianeta, nel frame eclittico. */
export function moonRelativeState(def: BodyDef, parent: BodyDef, t: number): StateVector {
  const el = moonOrbitalElements(def, parent.gm, t);
  const s = elementsToState(el, parent.gm + def.gm);
  if (def.moonElements?.frame === 'parentEquator' && parent.pole) {
    const basis = equatorialBasis(parent.pole.ra, parent.pole.dec);
    return { r: fromBasis(basis, s.r), v: fromBasis(basis, s.v) };
  }
  return s;
}

/** Stato eliocentrico kepleriano del baricentro di un sistema planetario (usato anche per validare). */
export function keplerianSystemState(catalog: readonly BodyDef[], def: BodyDef, t: number): StateVector {
  const sun = catalog.find((b) => b.kind === 'star');
  if (!sun) throw new Error('Catalogo senza stella centrale');
  return elementsToState(planetOrbitalElements(def, t), sun.gm + systemGM(catalog, def));
}

/** Semiasse maggiore nominale dell'orbita di un corpo attorno al suo primario [m]. */
export function nominalSemiMajorAxis(def: BodyDef, t = 0): number {
  if (def.planetElements) return planetOrbitalElements(def, t).a;
  if (def.moonElements) return def.moonElements.a * KM;
  return 0;
}

/** Vettori di stato baricentrici di tutti i corpi del catalogo al tempo t [s da J2000]. */
export function buildInitialStates(catalog: readonly BodyDef[], t: number): InitialBodyState[] {
  const sun = catalog.find((b) => b.kind === 'star');
  if (!sun) throw new Error('Catalogo senza stella centrale');
  const out: InitialBodyState[] = [{ def: sun, r: new Vec3(), v: new Vec3() }];

  for (const planet of catalog) {
    if (!planet.planetElements) continue;
    const bary = keplerianSystemState(catalog, planet, t);
    const moons = moonsOf(catalog, planet.id).map((m) => ({ def: m, ...moonRelativeState(m, planet, t) }));
    const mSys = systemGM(catalog, planet);

    // Posizione/velocità del pianeta rispetto al baricentro del proprio sistema
    const rp = new Vec3();
    const vp = new Vec3();
    for (const m of moons) {
      rp.addScaledInPlace(m.r, -m.def.gm / mSys);
      vp.addScaledInPlace(m.v, -m.def.gm / mSys);
    }
    const rPlanet = bary.r.add(rp);
    const vPlanet = bary.v.add(vp);
    out.push({ def: planet, r: rPlanet, v: vPlanet });
    for (const m of moons) out.push({ def: m.def, r: rPlanet.add(m.r), v: vPlanet.add(m.v) });
  }

  // Riferimento al baricentro del Sistema Solare
  let mTot = 0;
  const R = new Vec3();
  const V = new Vec3();
  for (const s of out) {
    mTot += s.def.gm;
    R.addScaledInPlace(s.r, s.def.gm);
    V.addScaledInPlace(s.v, s.def.gm);
  }
  const Rc = R.scale(1 / mTot);
  const Vc = V.scale(1 / mTot);
  return out.map((s) => ({ def: s.def, r: s.r.sub(Rc), v: s.v.sub(Vc) }));
}
