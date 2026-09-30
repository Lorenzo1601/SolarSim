/**
 * Test del motore fisico (STEP 1):  npm test
 * Usa il test runner integrato di Node (≥ 22.18, TypeScript eseguito nativamente).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AU, DAY, DEG, JULIAN_YEAR, KM, TWO_PI, simTimeFromDate } from '../src/physics/constants.ts';
import { keplerianSystemState } from '../src/physics/initialState.ts';
import {
  elementsToState, sampleOrbit, solveKeplerElliptic, solveKeplerHyperbolic, stateToElements,
  type OrbitalElements,
} from '../src/physics/kepler.ts';
import { NBodySystem } from '../src/physics/nbody.ts';
import { Simulation } from '../src/physics/simulation.ts';
import { Vec3 } from '../src/physics/vec3.ts';

const MU_SUN = 1.32712440041279e20;
const MU_EARTH = 3.98600435507e14;
const START = simTimeFromDate(new Date('2026-01-01T00:00:00Z'));

const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('Equazione di Keplero', () => {
  it('ellittica: residuo < 1e-12 anche con e → 1', () => {
    for (const e of [0, 0.1, 0.5, 0.9, 0.99, 0.999999]) {
      for (let M = -6; M <= 6; M += 0.37) {
        const E = solveKeplerElliptic(M, e);
        assert.ok(angDiff(E - e * Math.sin(E), M) < 1e-12, `e=${e} M=${M}`);
      }
    }
  });

  it('iperbolica: residuo relativo < 1e-12', () => {
    for (const e of [1.0001, 1.5, 3, 20]) {
      for (const M of [-50, -2, -0.01, 0, 0.3, 5, 200]) {
        const H = solveKeplerHyperbolic(M, e);
        assert.ok(Math.abs(e * Math.sinh(H) - H - M) < 1e-12 * Math.max(1, Math.abs(M)), `e=${e} M=${M}`);
      }
    }
  });
});

describe('Conversioni elementi ↔ stato', () => {
  const cases: OrbitalElements[] = [
    { a: 1 * AU, e: 0.0167, i: 0.1 * DEG, raan: 1.2, argp: 2.0, M: 0.5 },
    { a: 26600 * KM, e: 0.74, i: 63.4 * DEG, raan: 4.0, argp: 4.71, M: 3.0 }, // Molniya
    { a: 3 * AU, e: 0.95, i: 150 * DEG, raan: 0.3, argp: 5.5, M: 6.0 }, // retrograda molto eccentrica
    { a: -20000 * KM, e: 1.8, i: 30 * DEG, raan: 2.0, argp: 1.0, M: -1.5 }, // iperbolica (flyby)
  ];
  for (const el of cases) {
    it(`roundtrip a=${(el.a / KM).toExponential(2)} km e=${el.e}`, () => {
      const mu = Math.abs(el.a) > AU / 2 ? MU_SUN : MU_EARTH;
      const s = elementsToState(el, mu);
      const o = stateToElements(s.r, s.v, mu);
      assert.ok(Math.abs(o.a - el.a) / Math.abs(el.a) < 1e-10, 'a');
      assert.ok(Math.abs(o.e - el.e) < 1e-10, 'e');
      assert.ok(angDiff(o.i, el.i) < 1e-10, 'i');
      assert.ok(angDiff(o.raan, el.raan) < 1e-9, 'raan');
      assert.ok(angDiff(o.argp, el.argp) < 1e-9, 'argp');
      assert.ok(Math.abs(o.M - el.M) < 1e-8 || angDiff(o.M, el.M) < 1e-8, 'M');
      // periasse = a(1 − e) per ogni conica
      assert.ok(Math.abs(o.periapsis - el.a * (1 - el.e)) / o.periapsis < 1e-10, 'periapsis');
    });
  }

  it('orbita circolare equatoriale: vis-viva e periodo', () => {
    const r = 7000 * KM;
    const v = Math.sqrt(MU_EARTH / r);
    const o = stateToElements(new Vec3(r, 0, 0), new Vec3(0, v, 0), MU_EARTH);
    assert.ok(o.e < 1e-12);
    assert.ok(Math.abs(o.a - r) < 1e-3);
    assert.ok(Math.abs(o.period - TWO_PI * Math.sqrt(r ** 3 / MU_EARTH)) < 1e-6);
    assert.equal(o.apoapsis, o.a * (1 + o.e));
  });

  it('sampleOrbit: tutti i punti giacciono sulla conica', () => {
    const el = cases[1];
    const p = el.a * (1 - el.e * el.e);
    for (const q of sampleOrbit(el, 64)) {
      // r = p / (1 + e cosν)  ⇔  r + e·(r·P̂) = p
      const s = elementsToState({ ...el, M: 0 }, MU_EARTH);
      const P = s.r.normalize();
      assert.ok(Math.abs(q.length() + el.e * q.dot(P) - p) / p < 1e-9);
    }
  });
});

describe('Integratori N-body (problema dei due corpi)', () => {
  for (const kind of ['verlet', 'rk4'] as const) {
    it(`${kind}: dopo un periodo torna al punto di partenza`, () => {
      const el: OrbitalElements = { a: 1 * AU, e: 0.3, i: 0.2, raan: 0.4, argp: 1.1, M: 0 };
      const s = elementsToState(el, MU_SUN);
      const sys = new NBodySystem();
      sys.addBody(MU_SUN, new Vec3(), new Vec3());
      sys.addBody(0, s.r, s.v); // particella di prova: il Sole resta fermo → Keplero esatto
      const T = TWO_PI * Math.sqrt(el.a ** 3 / MU_SUN);
      const N = 2000;
      for (let k = 0; k < N; k++) sys.step(T / N, kind);
      const err = sys.getPosition(1).distanceTo(s.r) / el.a;
      assert.ok(err < (kind === 'rk4' ? 1e-7 : 2e-4), `errore relativo ${err}`);
    });
  }
});

describe('Sistema Solare', () => {
  it('conservazione di energia e quantità di moto su un anno (Verlet)', () => {
    const sim = new Simulation(START);
    const e0 = sim.totalEnergy();
    sim.advance(JULIAN_YEAR);
    const dE = Math.abs((sim.totalEnergy() - e0) / e0);
    assert.ok(dE < 1e-9, `|ΔE/E| = ${dE}`);
    // quantità di moto iniziale nulla (frame baricentrico)
    const p = sim.system.totalMomentum().length();
    const pScale = 2e30 * 30000 * 1e-3; // ≈ ‰ di M_sole × v_terra
    assert.ok(p < pScale * 1e-9, `|P| = ${p}`);
  });

  it('dopo un anno i pianeti coincidono con le effemeridi (< 0.1°, < 0.05%)', () => {
    const sim = new Simulation(START);
    sim.advance(JULIAN_YEAR);
    const sun = sim.position('sun');
    for (const b of sim.bodies) {
      if (!b.def?.planetElements) continue;
      const helio = sim.systemBarycenter(b.id).r.sub(sun);
      const ref = keplerianSystemState(sim.catalog, b.def, sim.time).r;
      assert.ok(helio.angleTo(ref) < 0.1 * DEG, `${b.id} longitudine`);
      assert.ok(Math.abs(helio.length() / ref.length() - 1) < 5e-4, `${b.id} distanza`);
    }
  });

  it('la Luna resta legata alla Terra con periodo ≈ 27.3 giorni', () => {
    const sim = new Simulation(START);
    const r0 = sim.relativeState('moon', 'earth').r;
    let dMin = Infinity, dMax = 0, prevAngle = 0, turns = 0, tCross = 0;
    const n = r0.cross(sim.relativeState('moon', 'earth').v).normalize();
    const step = 0.05 * DAY;
    for (let t = step; t <= 60 * DAY; t += step) {
      sim.advance(step);
      const r = sim.relativeState('moon', 'earth').r;
      const d = r.length();
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
      const ang = Math.atan2(r0.cross(r).dot(n), r0.dot(r));
      if (prevAngle < 0 && ang >= 0 && turns === 0) { turns = 1; tCross = t; }
      prevAngle = ang;
    }
    assert.ok(dMin > 350000 * KM && dMax < 410000 * KM, `distanza ${dMin / KM}–${dMax / KM} km`);
    assert.ok(Math.abs(tCross / DAY - 27.32) < 0.4, `periodo ${tCross / DAY} g`);
  });

  it('corpo dominante e telemetria', () => {
    const sim = new Simulation(START);
    assert.equal(sim.dominantBody('moon').id, 'earth');
    assert.equal(sim.dominantBody('earth').id, 'sun');
    assert.equal(sim.dominantBody('io').id, 'jupiter');
    const t = sim.telemetry('earth');
    assert.ok(t.speed > 29000 && t.speed < 31000, `v Terra ${t.speed}`);
    assert.ok(t.orbit.periapsis < t.orbit.apoapsis);
    assert.ok(t.accelerationMagnitude > 5.5e-3 && t.accelerationMagnitude < 6.3e-3, `a Terra ${t.accelerationMagnitude}`);
  });

  it('sonda (particella di prova) in orbita bassa terrestre', () => {
    const sim = new Simulation(START, { stepsPerOrbit: 400 });
    const rE = sim.position('earth');
    const vE = sim.velocity('earth');
    const r = 6771 * KM; // 400 km di quota
    const v = Math.sqrt((MU_EARTH) / r);
    sim.addProbe('leo', 'Sonda LEO', rE.add(new Vec3(r, 0, 0)), vE.add(new Vec3(0, v, 0)));
    const T = TWO_PI * Math.sqrt(r ** 3 / MU_EARTH);
    sim.advance(3 * T, T / 400);
    const t = sim.telemetry('leo');
    assert.equal(t.refId, 'earth');
    assert.ok(Math.abs(t.altitude - 400 * KM) < 5 * KM, `quota ${t.altitude / KM} km`);
    assert.ok(t.orbit.isBound);
  });

  it('time-warp: budget di sotto-passi rispettato', () => {
    const sim = new Simulation(START, { maxSubstepsPerFrame: 100 });
    sim.timeWarp = 1_000_000;
    const f = sim.update(1 / 60);
    assert.ok(f.limited);
    assert.equal(f.substeps, 100);
    assert.ok(f.simulated < f.requested);
    sim.maxSubstepsPerFrame = 5000;
    const g = sim.update(1 / 60);
    assert.ok(!g.limited);
    assert.ok(Math.abs(g.simulated - 1e6 / 60) < 1e-6);
    sim.paused = true;
    assert.equal(sim.update(1 / 60).simulated, 0);
  });
});
