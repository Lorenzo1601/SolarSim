/** Test della grafica "fisica": orientamento dei corpi, quota sull'ellissoide, colori delle stelle. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Simulation } from '../src/physics/simulation.ts';
import { Vec3 } from '../src/physics/vec3.ts';
import { FLATTENING, bodyOrientation, earthAxes } from '../src/graphics/bodyRotation.ts';
import { ScaleManager } from '../src/graphics/ScaleManager.ts';
import { bvToRgb } from '../src/graphics/sky.ts';

const DEG = Math.PI / 180;

/** Longitudine (° E) del punto sub-solare nel riferimento della texture della Terra. */
function subsolarLongitude(date: string): number {
  const sim = Simulation.fromDate(new Date(date));
  const q = new THREE.Quaternion();
  assert.ok(bodyOrientation(sim, 'earth', sim.time, q));
  const lon0 = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const east = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const s = sim.position('sun').sub(sim.position('earth'));
  const sun = ScaleManager.toThreeAxes(s.x, s.y, s.z).normalize();
  return Math.atan2(sun.dot(east), sun.dot(lon0)) / DEG;
}

describe('Orientamento dei corpi', () => {
  it('Terra: a mezzogiorno UTC dell\'equinozio il Sole è su Greenwich (± equazione del tempo)', () => {
    // 20/03/2026 12:00 UTC: mezzogiorno vero a Greenwich alle 12:07 → sub-solare ≈ 1,9° E
    const lon = subsolarLongitude('2026-03-20T12:00:00Z');
    assert.ok(Math.abs(lon - 1.9) < 1.0, `longitudine sub-solare ${lon.toFixed(2)}°`);
    // sei ore dopo il Sole è 90° più a ovest
    const lon6 = subsolarLongitude('2026-03-20T18:00:00Z');
    assert.ok(Math.abs(lon6 - (1.9 - 90)) < 1.0, `dopo 6 h ${lon6.toFixed(2)}°`);
  });

  it('Luna: la longitudine 0 guarda la Terra (rotazione sincrona)', () => {
    const sim = Simulation.fromDate(new Date('2026-09-30T00:00:00Z'));
    const q = new THREE.Quaternion();
    assert.ok(bodyOrientation(sim, 'moon', sim.time, q));
    const lon0 = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const d = sim.position('earth').sub(sim.position('moon'));
    const toEarth = ScaleManager.toThreeAxes(d.x, d.y, d.z).normalize();
    assert.ok(lon0.angleTo(toEarth) < 7 * DEG); // resta solo l'inclinazione dell'equatore lunare
  });

  it('asse terrestre di data: precessione del polo di ~0,15° dal 2000 al 2026', () => {
    const ax = earthAxes(Simulation.fromDate(new Date('2026-01-01T00:00:00Z')).time);
    const eq = new Vec3(0, 0.3977771559, 0.9174820621); // polo J2000 in eclittica
    const ang = Math.acos(ax.pole.normalize().dot(eq)) / DEG;
    assert.ok(ang > 0.1 && ang < 0.2, `${ang}`);
  });
});

describe('Quota sull\'ellissoide (scala logaritmica)', () => {
  it('un punto sulla superficie reale cade sulla superficie grafica schiacciata', () => {
    const sm = new ScaleManager('log');
    const pole = new Vec3(0, 0, 1);
    sm.setOblateness('earth', FLATTENING.earth, pole);
    const body = { id: 'earth', kind: 'planet' as const, radius: 6371e3 };
    const a = 6371e3 / (1 - FLATTENING.earth / 3);
    const q = 1 - FLATTENING.earth;
    for (const latDeg of [0, 28.6, 45, 80]) {
      const lat = latDeg * DEG;
      // raggio dell'ellissoide nella direzione geocentrica
      const k = 1 / Math.sqrt(Math.cos(lat) ** 2 + Math.sin(lat) ** 2 / (q * q));
      const p = new Vec3(Math.cos(lat), 0, Math.sin(lat)).scale(a * k);
      const out = sm.mapSatelliteOffset(p, body);
      const Rv = sm.visualRadius(body);
      assert.ok(Math.abs(out.length() / (Rv * k) - 1) < 1e-9, `lat ${latDeg}`);
    }
  });
});

describe('Colore delle stelle (B−V)', () => {
  it('stelle calde azzurrine, fredde arancioni', () => {
    const rigel = bvToRgb(-0.03);
    const sun = bvToRgb(0.65);
    const betelgeuse = bvToRgb(1.85);
    assert.ok(rigel[2] >= rigel[0]);
    assert.ok(sun[0] >= sun[1] && sun[1] >= sun[2]);
    assert.ok(betelgeuse[0] > betelgeuse[2] + 0.2);
  });
});
