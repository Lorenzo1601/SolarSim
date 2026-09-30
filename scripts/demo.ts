/**
 * Demo da console dello STEP 1:  npm run demo
 * Crea il Sistema Solare alla data odierna, stampa lo stato iniziale, integra per un anno
 * con entrambi gli integratori e confronta con le effemeridi kepleriane di riferimento.
 */
import { AU, DAY, KM, RAD, JULIAN_YEAR } from '../src/physics/constants.ts';
import { keplerianSystemState } from '../src/physics/initialState.ts';
import type { IntegratorKind } from '../src/physics/nbody.ts';
import { Simulation } from '../src/physics/simulation.ts';

const start = new Date();
const pad = (s: string | number, n: number) => String(s).padStart(n);

function header(sim: Simulation) {
  console.log(`\n=== Sistema Solare al ${sim.date.toISOString()} ===`);
  console.log(`Corpi: ${sim.bodies.length}   passo max: ${sim.maxStep.toFixed(1)} s   integratore: ${sim.integrator}`);
  console.log(`${'corpo'.padEnd(10)} ${pad('rif', 8)} ${pad('dist', 14)} ${pad('v [km/s]', 9)} ${pad('a', 13)} ${pad('e', 7)} ${pad('i [°]', 7)} ${pad('periasse', 13)} ${pad('apoasse', 13)} ${pad('periodo', 11)}`);
  for (const b of sim.bodies) {
    if (b.kind === 'star') continue;
    const t = sim.telemetry(b.id);
    const o = t.orbit;
    const inAU = t.refId === 'sun';
    const L = (m: number) => (inAU ? `${(m / AU).toFixed(5)} AU` : `${(m / KM).toFixed(0)} km`);
    const P = o.period / DAY;
    console.log(
      `${b.name.padEnd(10)} ${pad(t.refId, 8)} ${pad(L(t.distance), 14)} ${pad((t.speed / 1000).toFixed(3), 9)} ${pad(L(o.a), 13)} ${pad(o.e.toFixed(4), 7)} ${pad((o.i * RAD).toFixed(2), 7)} ${pad(L(o.periapsis), 13)} ${pad(L(o.apoapsis), 13)} ${pad(P > 1000 ? (P / 365.25).toFixed(2) + ' a' : P.toFixed(3) + ' g', 11)}`,
    );
  }
}

function run(integrator: IntegratorKind, years: number) {
  const sim = Simulation.fromDate(start, { integrator });
  const e0 = sim.totalEnergy();
  const t0 = performance.now();
  sim.advance(years * JULIAN_YEAR);
  const ms = performance.now() - t0;
  const dE = Math.abs((sim.totalEnergy() - e0) / e0);
  console.log(`\n--- ${integrator.toUpperCase()}: ${years} anno/i simulati in ${(ms / 1000).toFixed(2)} s  (≈ ${((years * JULIAN_YEAR) / (ms / 1000) / 1e6).toFixed(1)} M× tempo reale), |ΔE/E| = ${dE.toExponential(2)}`);
  console.log(`${'pianeta'.padEnd(10)} ${pad('Δ long. [°]', 12)} ${pad('Δ dist [%]', 11)}   (N-body vs effemeridi kepleriane)`);
  const sunPos = sim.position('sun');
  for (const b of sim.bodies) {
    if (!b.def?.planetElements) continue;
    const bc = sim.systemBarycenter(b.id);
    const helio = bc.r.sub(sunPos);
    const ref = keplerianSystemState(sim.catalog, b.def, sim.time).r;
    const dLon = helio.angleTo(ref) * RAD;
    const dDist = ((helio.length() - ref.length()) / ref.length()) * 100;
    console.log(`${b.name.padEnd(10)} ${pad(dLon.toFixed(4), 12)} ${pad(dDist.toFixed(4), 11)}`);
  }
  return sim;
}

header(Simulation.fromDate(start));
run('verlet', 1);
run('rk4', 1);

// Time-warp: 1 secondo reale a 60 fps con warp 1.000.000x
const sim = Simulation.fromDate(start);
sim.timeWarp = 1_000_000;
const t0 = performance.now();
let substeps = 0;
for (let f = 0; f < 60; f++) substeps += sim.update(1 / 60).substeps;
console.log(`\nTime-warp 1.000.000x: 60 frame → ${(sim.lastFrame.simulated * 60 / DAY).toFixed(2)} giorni simulati, ${substeps / 60} sotto-passi/frame, ${((performance.now() - t0) / 60).toFixed(2)} ms/frame, limitato=${sim.lastFrame.limited}`);
