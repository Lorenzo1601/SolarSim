/**
 * Motore N-body.
 *
 * Stato memorizzato in Float64Array contigui (x0,y0,z0,x1,y1,z1,...) per prestazioni.
 * Ogni corpo ha un parametro gravitazionale μ = G·m:
 *   μ > 0  → corpo massivo: attrae e viene attratto
 *   μ = 0  → particella di prova (sonde, razzi): subisce la gravità ma non la esercita
 *
 * Accelerazione sul corpo i:  a_i = Σ_j μ_j (r_j − r_i) / |r_j − r_i|³
 *
 * Integratori:
 *   'verlet' – Velocity Verlet / leapfrog KDK, 2° ordine, SIMPLETTICO: l'errore sull'energia resta
 *              limitato su tempi lunghissimi → ideale per le orbite planetarie. 1 valutazione/passo.
 *   'rk4'    – Runge–Kutta classico, 4° ordine: più preciso sul singolo passo ma non simplettico
 *              (l'energia deriva lentamente). 4 valutazioni/passo. Utile per traiettorie brevi e
 *              precise (manovre, flyby).
 */
import { G } from './constants.ts';
import { Vec3 } from './vec3.ts';

export type IntegratorKind = 'verlet' | 'rk4';

export class NBodySystem {
  /** Numero di corpi attivi. */
  n = 0;
  mu: Float64Array;
  pos: Float64Array;
  vel: Float64Array;
  acc: Float64Array;

  private massive: number[] = [];
  private test: number[] = [];
  private accValid = false;

  // Buffer di lavoro per RK4
  private sPos: Float64Array;
  private sV2: Float64Array;
  private sV3: Float64Array;
  private sV4: Float64Array;
  private sA2: Float64Array;
  private sA3: Float64Array;
  private sA4: Float64Array;

  constructor(capacity = 32) {
    this.mu = new Float64Array(capacity);
    this.pos = new Float64Array(capacity * 3);
    this.vel = new Float64Array(capacity * 3);
    this.acc = new Float64Array(capacity * 3);
    this.sPos = new Float64Array(capacity * 3);
    this.sV2 = new Float64Array(capacity * 3);
    this.sV3 = new Float64Array(capacity * 3);
    this.sV4 = new Float64Array(capacity * 3);
    this.sA2 = new Float64Array(capacity * 3);
    this.sA3 = new Float64Array(capacity * 3);
    this.sA4 = new Float64Array(capacity * 3);
  }

  get capacity(): number {
    return this.mu.length;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const g = (a: Float64Array, len: number) => {
      const b = new Float64Array(len);
      b.set(a);
      return b;
    };
    this.mu = g(this.mu, cap);
    this.pos = g(this.pos, cap * 3);
    this.vel = g(this.vel, cap * 3);
    this.acc = g(this.acc, cap * 3);
    this.sPos = new Float64Array(cap * 3);
    this.sV2 = new Float64Array(cap * 3);
    this.sV3 = new Float64Array(cap * 3);
    this.sV4 = new Float64Array(cap * 3);
    this.sA2 = new Float64Array(cap * 3);
    this.sA3 = new Float64Array(cap * 3);
    this.sA4 = new Float64Array(cap * 3);
  }

  /** Aggiunge un corpo e restituisce il suo indice. */
  addBody(mu: number, r: Vec3, v: Vec3): number {
    if (this.n === this.capacity) this.grow();
    const i = this.n++;
    this.mu[i] = mu;
    r.toArray(this.pos, i * 3);
    v.toArray(this.vel, i * 3);
    (mu > 0 ? this.massive : this.test).push(i);
    this.accValid = false;
    return i;
  }

  /** Imposta posizione e velocità di un corpo (es. dopo una manovra). */
  setState(i: number, r: Vec3, v: Vec3): void {
    r.toArray(this.pos, i * 3);
    v.toArray(this.vel, i * 3);
    this.accValid = false;
  }

  /** Applica un impulso istantaneo Δv [m/s] a un corpo. */
  applyDeltaV(i: number, dv: Vec3): void {
    this.vel[i * 3] += dv.x;
    this.vel[i * 3 + 1] += dv.y;
    this.vel[i * 3 + 2] += dv.z;
  }

  getPosition(i: number): Vec3 {
    return Vec3.fromArray(this.pos, i * 3);
  }

  getVelocity(i: number): Vec3 {
    return Vec3.fromArray(this.vel, i * 3);
  }

  /** Accelerazione gravitazionale corrente [m/s²]. */
  getAcceleration(i: number): Vec3 {
    this.ensureAccelerations();
    return Vec3.fromArray(this.acc, i * 3);
  }

  /** Calcola le accelerazioni per le posizioni `pos` e le scrive in `out`. */
  computeAccelerations(pos: Float64Array, out: Float64Array): void {
    const { mu, massive, test } = this;
    out.fill(0, 0, this.n * 3);
    const nm = massive.length;

    // Coppie massive: sfrutta la simmetria (3° principio) → N(N−1)/2 interazioni
    for (let a = 0; a < nm; a++) {
      const i = massive[a];
      const i3 = i * 3;
      const xi = pos[i3], yi = pos[i3 + 1], zi = pos[i3 + 2];
      const mui = mu[i];
      let axi = 0, ayi = 0, azi = 0;
      for (let b = a + 1; b < nm; b++) {
        const j = massive[b];
        const j3 = j * 3;
        const dx = pos[j3] - xi, dy = pos[j3 + 1] - yi, dz = pos[j3 + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        const inv = 1 / (r2 * Math.sqrt(r2));
        const fi = mu[j] * inv;
        const fj = mui * inv;
        axi += dx * fi; ayi += dy * fi; azi += dz * fi;
        out[j3] -= dx * fj; out[j3 + 1] -= dy * fj; out[j3 + 2] -= dz * fj;
      }
      out[i3] += axi; out[i3 + 1] += ayi; out[i3 + 2] += azi;
    }

    // Particelle di prova: solo attrazione dai corpi massivi
    for (const k of test) {
      const k3 = k * 3;
      const xk = pos[k3], yk = pos[k3 + 1], zk = pos[k3 + 2];
      let ax = 0, ay = 0, az = 0;
      for (let b = 0; b < nm; b++) {
        const j = massive[b];
        const j3 = j * 3;
        const dx = pos[j3] - xk, dy = pos[j3 + 1] - yk, dz = pos[j3 + 2] - zk;
        const r2 = dx * dx + dy * dy + dz * dz;
        const f = mu[j] / (r2 * Math.sqrt(r2));
        ax += dx * f; ay += dy * f; az += dz * f;
      }
      out[k3] = ax; out[k3 + 1] = ay; out[k3 + 2] = az;
    }
  }

  ensureAccelerations(): void {
    if (!this.accValid) {
      this.computeAccelerations(this.pos, this.acc);
      this.accValid = true;
    }
  }

  /** Avanza il sistema di dt secondi. */
  step(dt: number, kind: IntegratorKind = 'verlet'): void {
    if (kind === 'rk4') this.stepRK4(dt);
    else this.stepVerlet(dt);
  }

  /** Leapfrog Kick–Drift–Kick. */
  private stepVerlet(dt: number): void {
    this.ensureAccelerations();
    const { pos, vel, acc } = this;
    const n3 = this.n * 3;
    const h = dt * 0.5;
    for (let k = 0; k < n3; k++) {
      vel[k] += acc[k] * h; // kick ½
      pos[k] += vel[k] * dt; // drift
    }
    this.computeAccelerations(pos, acc);
    for (let k = 0; k < n3; k++) vel[k] += acc[k] * h; // kick ½
    this.accValid = true;
  }

  /** Runge–Kutta 4 sul sistema (r' = v, v' = a(r)). */
  private stepRK4(dt: number): void {
    this.ensureAccelerations();
    const { pos, vel, sPos, sV2, sV3, sV4, sA2, sA3, sA4 } = this;
    const a1 = this.acc;
    const n3 = this.n * 3;
    const h = dt * 0.5;

    for (let k = 0; k < n3; k++) {
      sPos[k] = pos[k] + vel[k] * h;
      sV2[k] = vel[k] + a1[k] * h;
    }
    this.computeAccelerations(sPos, sA2);
    for (let k = 0; k < n3; k++) {
      sPos[k] = pos[k] + sV2[k] * h;
      sV3[k] = vel[k] + sA2[k] * h;
    }
    this.computeAccelerations(sPos, sA3);
    for (let k = 0; k < n3; k++) {
      sPos[k] = pos[k] + sV3[k] * dt;
      sV4[k] = vel[k] + sA3[k] * dt;
    }
    this.computeAccelerations(sPos, sA4);
    const c = dt / 6;
    for (let k = 0; k < n3; k++) {
      pos[k] += c * (vel[k] + 2 * sV2[k] + 2 * sV3[k] + sV4[k]);
      vel[k] += c * (a1[k] + 2 * sA2[k] + 2 * sA3[k] + sA4[k]);
    }
    this.accValid = false;
  }

  /** Energia meccanica totale dei corpi massivi [J]. */
  totalEnergy(): number {
    const { mu, pos, vel, massive } = this;
    let ke = 0;
    let pe = 0;
    for (let a = 0; a < massive.length; a++) {
      const i = massive[a];
      const i3 = i * 3;
      ke += 0.5 * mu[i] * (vel[i3] ** 2 + vel[i3 + 1] ** 2 + vel[i3 + 2] ** 2);
      for (let b = a + 1; b < massive.length; b++) {
        const j = massive[b];
        const j3 = j * 3;
        const r = Math.hypot(pos[j3] - pos[i3], pos[j3 + 1] - pos[i3 + 1], pos[j3 + 2] - pos[i3 + 2]);
        pe -= (mu[i] * mu[j]) / r;
      }
    }
    return (ke + pe) / G;
  }

  /** Quantità di moto totale [kg·m/s]. */
  totalMomentum(): Vec3 {
    const p = new Vec3();
    for (const i of this.massive) p.addScaledInPlace(this.getVelocity(i), this.mu[i] / G);
    return p;
  }

  /** Centro di massa dei corpi massivi [m]. */
  centerOfMass(): Vec3 {
    const c = new Vec3();
    let m = 0;
    for (const i of this.massive) {
      c.addScaledInPlace(this.getPosition(i), this.mu[i]);
      m += this.mu[i];
    }
    return c.scale(1 / m);
  }
}
