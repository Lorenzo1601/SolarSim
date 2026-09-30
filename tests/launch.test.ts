/** Test del simulatore di lancio: atmosfera, Lambert, salita fisica, missioni complete. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AU, DAY } from '../src/physics/constants.ts';
import { elementsToState, propagateKepler } from '../src/physics/kepler.ts';
import { Simulation } from '../src/physics/simulation.ts';
import { Vec3 } from '../src/physics/vec3.ts';
import { atmosphere } from '../src/launch/atmosphere.ts';
import { DEG_RAD, idealDeltaV, launchAzimuth, optimizePitchKick } from '../src/launch/ascent.ts';
import { R_EQ, gmst } from '../src/launch/earthModel.ts';
import { LaunchMission, type MissionConfig } from '../src/launch/mission.ts';
import { MU_SUN, hyperbolicVelocity, lambert, searchTransfer, ssoInclination } from '../src/launch/planner.ts';
import { snapshot } from '../src/launch/propagator.ts';
import { ROCKETS, SITES } from '../src/launch/rockets.ts';

const rocket = (id: string) => ROCKETS.find((r) => r.id === id)!;
const site = (id: string) => SITES.find((s) => s.id === id)!;

describe('Atmosfera US 1976', () => {
  it('valori tabulati a 0, 11, 20, 50 km', () => {
    const a0 = atmosphere(0);
    assert.ok(Math.abs(a0.rho - 1.225) < 0.002 && Math.abs(a0.p - 101325) < 1 && Math.abs(a0.a - 340.3) < 0.5);
    assert.ok(Math.abs(atmosphere(11000).T - 216.8) < 0.5);
    assert.ok(Math.abs(atmosphere(20000).p - 5529) / 5529 < 0.02);
    assert.ok(Math.abs(atmosphere(50000).rho - 1.027e-3) / 1.027e-3 < 0.05);
    assert.ok(atmosphere(400000).rho > 1e-12 && atmosphere(400000).rho < 1e-11);
  });
});

describe('Pianificazione', () => {
  it('Lambert coerente con la propagazione kepleriana', () => {
    const s = elementsToState({ a: 1.3 * AU, e: 0.2, i: 0.05, raan: 1, argp: 2, M: 0.3 }, MU_SUN);
    const tof = 200 * DAY;
    const e = propagateKepler(s.r, s.v, MU_SUN, tof);
    const sol = lambert(s.r, e.r, tof, MU_SUN, true)!;
    assert.ok(sol.v1.distanceTo(s.v) < 1e-3, `v1 errore ${sol.v1.distanceTo(s.v)}`);
    assert.ok(sol.v2.distanceTo(e.v) < 1e-3);
  });

  it('inclinazione eliosincrona a 600 km ≈ 97,8°', () => {
    assert.ok(Math.abs(ssoInclination(600e3) / DEG_RAD - 97.79) < 0.1);
  });

  it('azimut di lancio: ISS da Cape Canaveral ≈ 45° (nord-est)', () => {
    const az = launchAzimuth(28.5 * DEG_RAD, 51.6 * DEG_RAD, 7700, false);
    assert.ok(az.reachable && Math.abs(az.rotating / DEG_RAD - 42.5) < 3, `${az.rotating / DEG_RAD}`);
    assert.ok(!launchAzimuth(45.9 * DEG_RAD, 28 * DEG_RAD, 7700, false).reachable);
  });

  it('finestra per Marte: C3 fra 7 e 20 km²/s², viaggio 150–350 giorni', () => {
    const sim = new Simulation(0);
    const t0 = (new Date('2026-06-01T00:00:00Z').getTime() / 1000) - 946728000;
    const p = searchTransfer(sim.catalog, 'mars', t0, 800, false, 400e3)!;
    const tof = (p.arrival - p.departure) / DAY;
    assert.ok(p.c3 / 1e6 > 7 && p.c3 / 1e6 < 20, `C3 ${p.c3 / 1e6}`);
    assert.ok(tof > 150 && tof < 350);
  });
});

describe('Salita fisica', () => {
  it('Falcon 9: 15 t in orbita bassa con MECO ~2:30 e Max-Q 25–40 kPa', () => {
    const r = rocket('falcon9');
    const opt = optimizePitchKick({
      rocket: r, payloadMass: 15000, site: site('ksc39a'), targetAltitude: 200e3, targetApoapsis: 400e3,
      inclination: 51.6 * DEG_RAD, southward: false, maxAccelG: 5, maxQ: 35000, pitchStartSpeed: 50, recovery: false, theta0: 0,
    });
    assert.ok(opt.result.success);
    const v = opt.result.vehicle;
    const meco = v.events.find((e) => e.kind === 'meco')!;
    assert.ok(meco.t > 130 && meco.t < 175, `MECO ${meco.t}`);
    assert.ok(v.maxQ > 25000 && v.maxQ < 40000, `Max-Q ${v.maxQ}`);
    const tel = v.telemetry();
    assert.ok(Math.abs(tel.inclination - 51.6) < 0.3, `i ${tel.inclination}`);
    assert.ok(Math.abs(tel.periapsis - 200e3) < 15e3 && Math.abs(tel.apoapsis - 400e3) < 40e3);
  });

  it('carico troppo pesante: orbita non raggiunta', () => {
    const r = rocket('electron');
    const opt = optimizePitchKick({
      rocket: r, payloadMass: 1500, site: site('mahia'), targetAltitude: 200e3, inclination: 45 * DEG_RAD,
      southward: false, maxAccelG: 5, maxQ: 35000, pitchStartSpeed: 50, recovery: false, theta0: 0,
    });
    assert.ok(!opt.result.success);
  });

  it('Δv ideale del Saturn V con 45 t: 12–14 km/s, spinta/peso al decollo > 1', () => {
    const d = idealDeltaV(rocket('saturnv'), 45000);
    assert.ok(d.total > 12000 && d.total < 14000 && d.twr > 1.1 && d.twr < 1.3);
  });
});

describe('Missioni complete', () => {
  const run = (cfg: MissionConfig, sim: Simulation, maxT: number) => {
    sim.resetToTime(cfg.launchTime - 10);
    const m = new LaunchMission(sim, cfg);
    while (sim.time < cfg.launchTime + maxT && m.phase !== 'failed' && m.phase !== 'complete') {
      const a = snapshot(sim);
      sim.advance(m.phase === 'ascent' || m.phase === 'countdown' ? 1 : m.burn ? 30 : 300);
      m.update(a, snapshot(sim));
    }
    return m;
  };
  const base = (sim: Simulation): Omit<MissionConfig, 'type'> => ({
    rocket: rocket('falcon9'), site: site('ksc39a'),
    payload: { name: 'Sat', mass: 5500, propellant: 2000, thrust: 450, isp: 320 },
    altitude: 550e3, inclination: 53 * DEG_RAD, southward: false, recovery: false, maxAccelG: 5, maxQ: 35000,
    pitchKick: 6 * DEG_RAD, parkingAltitude: 200e3, launchTime: sim.time + 10, arrivalMode: 'orbit', arrivalAltitude: 100e3,
  });

  it('LEO 550 km: inserimento + circolarizzazione all\'apogeo', () => {
    const sim = new Simulation(8.4e8);
    const m = run({ ...base(sim), type: 'leo' }, sim, 3 * 3600);
    assert.equal(m.phase, 'complete');
    const t = m.telemetry();
    assert.ok(Math.abs(t.periapsis - 550e3) < 25e3 && Math.abs(t.apoapsis - 550e3) < 40e3, `${t.periapsis} × ${t.apoapsis}`);
  });

  it('GTO: apogeo a quota geostazionaria', () => {
    const sim = new Simulation(8.4e8);
    const cfg = { ...base(sim), type: 'gto' as const, inclination: 28.9 * DEG_RAD };
    cfg.pitchKick = optimizePitchKick({
      rocket: cfg.rocket, payloadMass: cfg.payload.mass, site: cfg.site, targetAltitude: 200e3, inclination: cfg.inclination,
      southward: false, maxAccelG: 5, maxQ: 35000, pitchStartSpeed: 50, recovery: false, theta0: gmst(cfg.launchTime),
    }).pitchKick;
    const m = run(cfg, sim, 3 * 3600);
    assert.equal(m.phase, 'complete');
    const t = m.telemetry();
    assert.ok(Math.abs(t.apoapsis - (42164e3 - R_EQ)) < 300e3, `apogeo ${t.apoapsis}`);
  });

  it('coerenza: la sonda in orbita bassa resta a quota costante (propagatore + J2 + resistenza)', () => {
    const sim = new Simulation(8.4e8);
    const m = run({ ...base(sim), type: 'leo' }, sim, 3 * 3600);
    const alt0 = m.telemetry().altitude;
    for (let k = 0; k < 20; k++) {
      const a = snapshot(sim);
      sim.advance(600);
      m.update(a, snapshot(sim));
    }
    const alt1 = m.telemetry().altitude;
    assert.ok(Math.abs(alt1 - alt0) < 60e3, `${alt0} → ${alt1}`);
    void new Vec3();
  });
});

describe('Iperbole di fuga', () => {
  it('la velocità richiesta produce esattamente l\'asintoto v∞ assegnato', () => {
    const mu = 3.986004418e14;
    const cases: [Vec3, Vec3][] = [
      [new Vec3(6578e3, 0, 0), new Vec3(-3000, -1000, 500)],
      [new Vec3(0, 6600e3, 100e3), new Vec3(-5000, 5000, -2000)],
      [new Vec3(6578e3, 0, 0), new Vec3(-3000, 3000, 0)],
    ];
    for (const [r, vInf] of cases) {
      const v = hyperbolicVelocity(r, vInf, mu, new Vec3(0, 0, 1))!;
      const h = r.cross(v);
      const ev = v.cross(h).scale(1 / mu).sub(r.normalize());
      const e = ev.length();
      const q = h.normalize().cross(ev.normalize());
      const s = ev.normalize().scale(-1 / e).add(q.scale(Math.sqrt(1 - 1 / (e * e))));
      const vi = Math.sqrt(v.lengthSq() - (2 * mu) / r.length());
      assert.ok(s.scale(vi).sub(vInf).length() < 0.01);
      assert.ok(h.z > 0);
    }
  });
});
