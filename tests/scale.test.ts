/** Test dello ScaleManager (gira in Node: usa solo la matematica di three.js, niente WebGL). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { AU, KM } from '../src/physics/constants.ts';
import { Simulation } from '../src/physics/simulation.ts';
import { Vec3 } from '../src/physics/vec3.ts';
import { ScaleManager } from '../src/graphics/ScaleManager.ts';

const sim = new Simulation(0);
const body = (id: string) => sim.get(id);

describe('ScaleManager', () => {
  it('assi: Z eclittica → Y di Three.js, la trasformazione è una rotazione (terna destrorsa)', () => {
    const v = ScaleManager.toThreeAxes(1, 2, 3);
    assert.deepEqual([v.x, v.y, v.z], [1, 3, -2]);
    const x = ScaleManager.toThreeAxes(1, 0, 0), y = ScaleManager.toThreeAxes(0, 1, 0), z = ScaleManager.toThreeAxes(0, 0, 1);
    assert.ok(new THREE.Vector3().crossVectors(x, y).distanceTo(z) < 1e-12);
    const back = ScaleManager.fromThreeAxes(v);
    assert.deepEqual([back.x, back.y, back.z], [1, 2, 3]);
  });

  it('log: distanza monotona crescente, direzione conservata, inversa corretta', () => {
    const s = new ScaleManager('log');
    let prev = 0;
    for (const d of [0.1, 0.39, 0.72, 1, 1.52, 5.2, 9.5, 19.2, 30, 49]) {
      const r = s.radial(d * AU);
      assert.ok(r > prev);
      prev = r;
      assert.ok(Math.abs(s.inverseRadial(r) / (d * AU) - 1) < 1e-9);
    }
    const rel = new Vec3(3 * AU, -4 * AU, 0.5 * AU);
    const p = s.mapHeliocentric(rel);
    const dir = ScaleManager.toThreeAxes(rel.x, rel.y, rel.z).normalize();
    assert.ok(p.clone().normalize().distanceTo(dir) < 1e-12);
  });

  it('log: tutti i pianeti tra 100 e 450 unità, ben separati rispetto alle loro dimensioni', () => {
    const s = new ScaleManager('log');
    const planets = sim.bodies.filter((b) => b.kind === 'planet');
    for (let k = 1; k < planets.length; k++) {
      const a = planets[k - 1], b = planets[k];
      const da = s.radial(b.def!.planetElements!.a * AU) - s.radial(a.def!.planetElements!.a * AU);
      assert.ok(da > 3 * (s.visualRadius(a) + s.visualRadius(b)), `${a.id}–${b.id}`);
    }
    assert.ok(s.radial(0.387 * AU) > 100 && s.radial(39.5 * AU) < 450);
  });

  it('log: gerarchia delle dimensioni conservata (Sole > Giove > Terra > Luna)', () => {
    const s = new ScaleManager('log');
    const r = (id: string) => s.visualRadius(body(id));
    assert.ok(r('sun') > r('jupiter') && r('jupiter') > r('earth') && r('earth') > r('moon') && r('moon') > r('phobos'));
  });

  it('log: le lune stanno fuori dalla sfera del pianeta e in ordine di distanza', () => {
    const s = new ScaleManager('log');
    for (const [planet, moons] of [['earth', ['moon']], ['mars', ['phobos', 'deimos']], ['jupiter', ['io', 'europa', 'ganymede', 'callisto']]] as const) {
      const p = body(planet);
      let prev = 0;
      for (const m of moons) {
        const d = s.mapSatelliteOffset(new Vec3(body(m).def!.moonElements!.a * KM, 0, 0), p).length();
        assert.ok(d > s.visualRadius(p) + s.visualRadius(body(m)), m);
        assert.ok(d > prev, `${m} ordine`);
        prev = d;
      }
    }
  });

  it('reale: lineare, 1 unità = 1 milione di km', () => {
    const s = new ScaleManager('real');
    assert.equal(s.radial(AU), AU / 1e9);
    assert.equal(s.visualRadius(body('earth')), 6371e3 / 1e9);
    const off = s.mapSatelliteOffset(new Vec3(384400 * KM, 0, 0), body('earth'));
    assert.ok(Math.abs(off.length() - 0.3844) < 1e-12);
  });

  it('cambio modalità incrementa la versione', () => {
    const s = new ScaleManager('log');
    const v0 = s.version;
    s.mode = 'log';
    assert.equal(s.version, v0);
    s.mode = 'real';
    assert.equal(s.version, v0 + 1);
  });

  it('raggio minimo in pixel proporzionale alla distanza', () => {
    const s = new ScaleManager('log');
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const r1 = s.minRadiusAt(100, cam, 1000), r2 = s.minRadiusAt(200, cam, 1000);
    assert.ok(Math.abs(r2 / r1 - 2) < 1e-12);
    // minPixelRadius px su 1000 px di altezza a fov 45° e distanza 100
    assert.ok(Math.abs(r1 - (100 * 2 * Math.tan(Math.PI / 8) / 1000) * s.settings.minPixelRadius) < 1e-12);
  });
});
