/**
 * Propagazione della sonda dopo l'inserimento in orbita, nel frame del motore fisico
 * (eclittica J2000, baricentrica, metri).
 *
 *  - Integratore adattivo Dormand–Prince 5(4) sul vettore (r, v, m).
 *  - Gravità di tutti i corpi massivi della simulazione; le loro posizioni fra l'inizio e la fine del
 *    frame vengono interpolate (Hermite) dagli stati del motore N-body → la sonda "vede" esattamente
 *    gli stessi pianeti disegnati a schermo.
 *  - J2 terrestre e resistenza atmosferica sotto i 1000 km.
 *  - Spinta finita opzionale con direzione calcolata a ogni valutazione.
 *
 * Contiene anche un predittore veloce (N-body ridotto + particella di prova) per la pianificazione
 * delle manovre (TLI, correzioni di rotta).
 */
import { Vec3 } from '../physics/vec3.ts';
import { NBodySystem } from '../physics/nbody.ts';
import type { Simulation } from '../physics/simulation.ts';
import { poleVectorEcliptic } from '../physics/frames.ts';
import { atmosphere } from './atmosphere.ts';
import { G0, J2_EARTH, OMEGA_EARTH, R_EQ } from './earthModel.ts';

/** Stati dei corpi massivi a un istante. */
export interface BodiesSnapshot {
  t: number;
  pos: Float64Array;
  vel: Float64Array;
}

export function snapshot(sim: Simulation): BodiesSnapshot {
  const n = sim.system.n * 3;
  return { t: sim.time, pos: sim.system.pos.slice(0, n), vel: sim.system.vel.slice(0, n) };
}

export interface ThrustSpec {
  /** Spinta [N]. */
  thrust: number;
  /** Portata [kg/s]. */
  mdot: number;
  /** Direzione unitaria di spinta in funzione dello stato. */
  direction(t: number, r: Vec3, v: Vec3): Vec3;
}

export interface SpacecraftShape {
  /** Area frontale [m²] e coefficiente di resistenza per la resistenza in orbita bassa. */
  area: number;
  cd: number;
}

const EARTH_POLE = poleVectorEcliptic(0, 90);

/** Campo gravitazionale interpolato fra due fotografie dei corpi. */
export class GravityField {
  private a: BodiesSnapshot;
  private b: BodiesSnapshot;
  readonly mu: Float64Array;
  readonly earthIndex: number;
  readonly massive: number[];

  constructor(sim: Simulation, a: BodiesSnapshot, b: BodiesSnapshot) {
    this.a = a;
    this.b = b;
    this.mu = sim.system.mu;
    this.earthIndex = sim.get('earth').index;
    this.massive = sim.bodies.filter((x) => x.gm > 0).map((x) => x.index);
  }

  /** Posizione (e velocità) interpolata del corpo i al tempo t (Hermite cubica). */
  body(i: number, t: number): { r: Vec3; v: Vec3 } {
    const { a, b } = this;
    const h = b.t - a.t;
    const i3 = i * 3;
    const ra = new Vec3(a.pos[i3], a.pos[i3 + 1], a.pos[i3 + 2]);
    const va = new Vec3(a.vel[i3], a.vel[i3 + 1], a.vel[i3 + 2]);
    if (h <= 0) return { r: ra, v: va };
    const rb = new Vec3(b.pos[i3], b.pos[i3 + 1], b.pos[i3 + 2]);
    const vb = new Vec3(b.vel[i3], b.vel[i3 + 1], b.vel[i3 + 2]);
    const s = Math.min(1, Math.max(0, (t - a.t) / h));
    const s2 = s * s;
    const s3 = s2 * s;
    const r = ra.scale(2 * s3 - 3 * s2 + 1).add(va.scale((s3 - 2 * s2 + s) * h)).add(rb.scale(-2 * s3 + 3 * s2)).add(vb.scale((s3 - s2) * h));
    const v = ra.scale((6 * s2 - 6 * s) / h).add(va.scale(3 * s2 - 4 * s + 1)).add(rb.scale((-6 * s2 + 6 * s) / h)).add(vb.scale(3 * s2 - 2 * s));
    return { r, v };
  }

  /** Accelerazione gravitazionale (+ J2 terrestre) sulla sonda in r al tempo t. */
  gravity(t: number, r: Vec3): Vec3 {
    let ax = 0, ay = 0, az = 0;
    for (const i of this.massive) {
      const p = this.body(i, t).r;
      const dx = p.x - r.x, dy = p.y - r.y, dz = p.z - r.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const f = this.mu[i] / (d2 * Math.sqrt(d2));
      ax += dx * f; ay += dy * f; az += dz * f;
      if (i === this.earthIndex && d2 < 1e18) {
        // J2 nel frame con asse = polo terrestre
        const rel = r.sub(p);
        const rr2 = rel.lengthSq();
        const rr = Math.sqrt(rr2);
        const zc = rel.dot(EARTH_POLE);
        const k = (-1.5 * J2_EARTH * this.mu[i] * R_EQ * R_EQ) / (rr2 * rr2 * rr);
        const zr2 = (zc * zc) / rr2;
        ax += k * (rel.x * (1 - 5 * zr2)) + k * EARTH_POLE.x * zc * 2;
        ay += k * (rel.y * (1 - 5 * zr2)) + k * EARTH_POLE.y * zc * 2;
        az += k * (rel.z * (1 - 5 * zr2)) + k * EARTH_POLE.z * zc * 2;
      }
    }
    return new Vec3(ax, ay, az);
  }

  earth(t: number): { r: Vec3; v: Vec3 } {
    return this.body(this.earthIndex, t);
  }
}

export interface ProbeState {
  t: number;
  r: Vec3;
  v: Vec3;
  m: number;
}

// Coefficienti Dormand–Prince 5(4)
const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const A: number[][] = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

type Y = Float64Array; // [x,y,z,vx,vy,vz,m]

export class ProbePropagator {
  state: ProbeState;
  /** Passo corrente suggerito [s]. */
  h = 10;
  /** Errore locale di posizione ammesso per passo [m] (velocità: 1/1000 in m/s). */
  posTolerance = 0.01;
  shape: SpacecraftShape = { area: 10, cd: 2.2 };
  thrust: ThrustSpec | null = null;
  /** Δv accumulato dalla spinta nella combustione corrente [m/s] (modulo e vettore). */
  burnDv = 0;
  burnDvVec = new Vec3();
  /** Accelerazione di spinta istantanea [m/s²] (telemetria). */
  thrustAccel = 0;

  constructor(state: ProbeState) {
    this.state = state;
  }

  private deriv(field: GravityField, t: number, y: Y, out: Y): void {
    const r = new Vec3(y[0], y[1], y[2]);
    const v = new Vec3(y[3], y[4], y[5]);
    const m = y[6];
    let a = field.gravity(t, r);
    // resistenza atmosferica terrestre
    const e = field.earth(t);
    const rel = r.sub(e.r);
    const alt = rel.length() - R_EQ;
    if (alt < 1_000_000) {
      const rho = atmosphere(alt).rho;
      if (rho > 0) {
        const vAir = v.sub(e.v).sub(EARTH_POLE.cross(rel).scale(OMEGA_EARTH));
        const sp = vAir.length();
        a = a.add(vAir.scale((-0.5 * rho * sp * this.shape.cd * this.shape.area) / m));
      }
    }
    let mdot = 0;
    if (this.thrust && m > 0) {
      a = a.add(this.thrust.direction(t, r, v).scale(this.thrust.thrust / m));
      mdot = this.thrust.mdot;
    }
    out[0] = v.x; out[1] = v.y; out[2] = v.z;
    out[3] = a.x; out[4] = a.y; out[5] = a.z;
    out[6] = -mdot;
  }

  /**
   * Avanza fino a tEnd. `maxStep` limita il passo (es. 1 s durante le combustioni).
   * `onStep` viene chiamata dopo ogni passo accettato; se restituisce true la propagazione si ferma.
   */
  propagate(field: GravityField, tEnd: number, maxStep: number, onStep?: (s: ProbeState) => boolean): void {
    const k = Array.from({ length: 7 }, () => new Float64Array(7));
    const y = new Float64Array(7);
    const yt = new Float64Array(7);
    const y5 = new Float64Array(7);
    let guard = 0;
    while (this.state.t < tEnd - 1e-9 && guard++ < 200000) {
      const s = this.state;
      let h = Math.min(this.h, maxStep, tEnd - s.t);
      y.set([s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z, s.m]);
      for (;;) {
        this.deriv(field, s.t, y, k[0]);
        for (let st = 1; st < 7; st++) {
          for (let j = 0; j < 7; j++) {
            let acc = y[j];
            for (let q = 0; q < st; q++) acc += h * A[st][q] * k[q][j];
            yt[j] = acc;
          }
          this.deriv(field, s.t + C[st] * h, yt, k[st]);
        }
        // Errore locale stimato (differenza fra le soluzioni di ordine 5 e 4)
        let errPos = 0;
        let errVel = 0;
        for (let j = 0; j < 7; j++) {
          let d5 = 0, d4 = 0;
          for (let q = 0; q < 7; q++) {
            d5 += B5[q] * k[q][j];
            d4 += B4[q] * k[q][j];
          }
          y5[j] = y[j] + h * d5;
          const e = Math.abs(h * (d5 - d4));
          if (j < 3) errPos = Math.max(errPos, e);
          else if (j < 6) errVel = Math.max(errVel, e);
        }
        const ratio = Math.max(errPos / this.posTolerance, errVel / (this.posTolerance * 1e-3));
        if (ratio <= 1 || h <= 1e-3) {
          const tNew = s.t + h;
          if (this.thrust) {
            const dv = (this.thrust.thrust / Math.max(y[6], 1e-6)) * h;
            this.burnDv += dv;
            const dir = this.thrust.direction(s.t, new Vec3(y[0], y[1], y[2]), new Vec3(y[3], y[4], y[5]));
            this.burnDvVec = this.burnDvVec.add(dir.scale(dv));
            this.thrustAccel = this.thrust.thrust / Math.max(y5[6], 1e-6);
          } else this.thrustAccel = 0;
          this.state = { t: tNew, r: new Vec3(y5[0], y5[1], y5[2]), v: new Vec3(y5[3], y5[4], y5[5]), m: y5[6] };
          const grow = ratio > 0 ? 0.9 * Math.pow(ratio, -0.2) : 5;
          this.h = Math.min(Math.max(h * Math.min(5, grow), 1e-3), 86400 * 2);
          break;
        }
        h = Math.max(h * Math.max(0.1, 0.9 * Math.pow(ratio, -0.25)), 1e-3);
      }
      if (onStep?.(this.state)) return;
    }
  }
}

/** Spinta/portata di un motore. */
export function engine(thrust: number, isp: number): { thrust: number; mdot: number } {
  return { thrust, mdot: thrust / (isp * G0) };
}

// ───────────────────────── Predittore veloce ─────────────────────────

/**
 * Sistema ridotto (Sole, pianeti, Luna) clonato dallo stato attuale della simulazione, con una
 * particella di prova: serve a prevedere traiettorie per la pianificazione delle manovre.
 */
export class Predictor {
  readonly system: NBodySystem;
  readonly probe: number;
  readonly ids: string[];
  t: number;

  /**
   * `at`: se indicato, gli stati dei corpi sono presi dal campo interpolato al tempo `at.t`
   * (istante esatto della sonda, che può stare fra l'inizio e la fine del frame).
   */
  constructor(
    sim: Simulation,
    r: Vec3,
    v: Vec3,
    include: string[] = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'],
    at?: { field: GravityField; t: number },
    /** Corpi inclusi senza gravità (es. il pianeta bersaglio per la mira "a linea retta"). */
    massless: string[] = [],
  ) {
    this.system = new NBodySystem(16);
    this.ids = [];
    const stateOf = (id: string) => {
      const b = sim.get(id);
      return at ? at.field.body(b.index, at.t) : { r: sim.position(id), v: sim.velocity(id) };
    };
    for (const id of include) {
      if (!sim.has(id)) continue;
      const b = sim.get(id);
      // pianeti con lune (tranne la Terra, la cui Luna è inclusa a parte): baricentro del sistema
      const members = id !== 'earth' && id !== 'moon' && id !== 'sun' ? sim.bodies.filter((x) => x.id === id || x.parentId === id) : [b];
      let gm = 0;
      const R = new Vec3();
      const V = new Vec3();
      for (const m of members) {
        const st = stateOf(m.id);
        R.addScaledInPlace(st.r, m.gm);
        V.addScaledInPlace(st.v, m.gm);
        gm += m.gm;
      }
      this.system.addBody(massless.includes(id) ? 0 : gm, R.scale(1 / gm), V.scale(1 / gm));
      this.ids.push(id);
    }
    this.probe = this.system.addBody(0, r, v);
    this.t = at ? at.t : sim.time;
  }

  index(id: string): number {
    return this.ids.indexOf(id);
  }

  /** Avanza di `duration` con passo `dt`; callback dopo ogni passo (true = stop). */
  run(duration: number, dt: number, cb?: (t: number) => boolean): void {
    const n = Math.max(1, Math.ceil(duration / dt));
    const h = duration / n;
    for (let i = 0; i < n; i++) {
      this.system.step(h, 'rk4');
      this.t += h;
      if (cb?.(this.t)) return;
    }
  }

  pos(i: number): Vec3 {
    return this.system.getPosition(i);
  }

  vel(i: number): Vec3 {
    return this.system.getVelocity(i);
  }
}
