/**
 * Simulation: orchestra il motore N-body, il tempo simulato e il time-warp,
 * e fornisce le grandezze di telemetria (orbita osculante, periapside, apoapside, velocità, accelerazione).
 */
import { SOLAR_SYSTEM, type BodyDef, type BodyKind } from '../data/bodies.ts';
import { TWO_PI, dateFromSimTime, simTimeFromDate } from './constants.ts';
import { buildInitialStates, nominalSemiMajorAxis } from './initialState.ts';
import { stateToElements, type OrbitInfo } from './kepler.ts';
import { NBodySystem, type IntegratorKind } from './nbody.ts';
import { Vec3 } from './vec3.ts';

export type SimBodyKind = BodyKind | 'probe';

export interface SimBody {
  id: string;
  name: string;
  kind: SimBodyKind;
  def: BodyDef | null;
  parentId: string | null;
  /** Indice nel sistema N-body. */
  index: number;
  /** GM [m^3/s^2] (0 per le sonde). */
  gm: number;
  /** Raggio [m]. */
  radius: number;
  /** Raggio della sfera d'influenza di Laplace [m]: r_SOI = a·(m/M)^(2/5). */
  soi: number;
}

export interface FrameReport {
  /** Tempo simulato richiesto in questo frame [s] (= dt reale × warp). */
  requested: number;
  /** Tempo effettivamente simulato [s]. */
  simulated: number;
  substeps: number;
  stepSize: number;
  /** true se il warp è stato limitato dal budget di sotto-passi. */
  limited: boolean;
}

export interface Telemetry {
  id: string;
  /** Corpo di riferimento (dominante gravitazionalmente o scelto). */
  refId: string;
  time: number;
  /** Posizione/velocità relative al riferimento. */
  relPosition: Vec3;
  relVelocity: Vec3;
  /** Distanza dal centro del riferimento [m]. */
  distance: number;
  /** Altitudine sopra la superficie del riferimento [m]. */
  altitude: number;
  /** Velocità relativa al riferimento [m/s]. */
  speed: number;
  /** Accelerazione gravitazionale totale (inerziale) [m/s²]. */
  acceleration: Vec3;
  accelerationMagnitude: number;
  orbit: OrbitInfo;
  periapsisAltitude: number;
  apoapsisAltitude: number;
}

/** Livelli di time-warp suggeriti per la UI. */
export const TIME_WARP_LEVELS = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000] as const;

export interface SimulationOptions {
  catalog?: readonly BodyDef[];
  integrator?: IntegratorKind;
  /** Passi di integrazione per orbita del corpo più veloce (precisione). Default 400. */
  stepsPerOrbit?: number;
  /** Limite di sotto-passi per frame (budget CPU). Default 5000. */
  maxSubstepsPerFrame?: number;
}

export class Simulation {
  readonly system = new NBodySystem(64);
  readonly bodies: SimBody[] = [];
  readonly catalog: readonly BodyDef[];
  private byId = new Map<string, SimBody>();

  /** Tempo simulato [s da J2000]. */
  time: number;
  timeWarp = 1;
  paused = false;
  integrator: IntegratorKind;
  maxSubstepsPerFrame: number;
  /** Massimo dt reale accettato per frame (evita salti quando la scheda torna attiva). */
  maxRealDt = 0.25;
  lastFrame: FrameReport = { requested: 0, simulated: 0, substeps: 0, stepSize: 0, limited: false };

  private _stepsPerOrbit: number;
  private _maxStep = 60;

  constructor(startTime: number, options: SimulationOptions = {}) {
    this.catalog = options.catalog ?? SOLAR_SYSTEM;
    this.integrator = options.integrator ?? 'verlet';
    this._stepsPerOrbit = options.stepsPerOrbit ?? 400;
    this.maxSubstepsPerFrame = options.maxSubstepsPerFrame ?? 5000;
    this.time = startTime;

    const sun = this.catalog.find((b) => b.kind === 'star');
    for (const s of buildInitialStates(this.catalog, startTime)) {
      const d = s.def;
      const index = this.system.addBody(d.gm, s.r, s.v);
      const parent = d.parent ? this.catalog.find((b) => b.id === d.parent) : undefined;
      const primaryGM = parent?.gm ?? sun?.gm ?? d.gm;
      const soi = d.parent ? nominalSemiMajorAxis(d, startTime) * Math.pow(d.gm / primaryGM, 0.4) : Infinity;
      this.register({
        id: d.id, name: d.name, kind: d.kind, def: d, parentId: d.parent,
        index, gm: d.gm, radius: d.radius, soi,
      });
    }
    this.updateMaxStep();
  }

  /** Crea una simulazione alla data indicata (default: adesso). */
  static fromDate(date: Date = new Date(), options?: SimulationOptions): Simulation {
    return new Simulation(simTimeFromDate(date), options);
  }

  get date(): Date {
    return dateFromSimTime(this.time);
  }

  /** Passo di integrazione massimo [s], derivato dall'orbita più rapida. */
  get maxStep(): number {
    return this._maxStep;
  }

  get stepsPerOrbit(): number {
    return this._stepsPerOrbit;
  }

  set stepsPerOrbit(v: number) {
    this._stepsPerOrbit = Math.max(20, v);
    this.updateMaxStep();
  }

  private updateMaxStep(): void {
    let minPeriod = Infinity;
    for (const b of this.bodies) {
      if (!b.def || !b.parentId) continue;
      const parent = this.byId.get(b.parentId);
      if (!parent) continue;
      const a = nominalSemiMajorAxis(b.def, this.time);
      const T = TWO_PI * Math.sqrt((a * a * a) / (parent.gm + b.gm));
      if (T < minPeriod) minPeriod = T;
    }
    this._maxStep = Number.isFinite(minPeriod) ? minPeriod / this._stepsPerOrbit : 3600;
  }

  private register(b: SimBody): void {
    this.bodies.push(b);
    this.byId.set(b.id, b);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): SimBody {
    const b = this.byId.get(id);
    if (!b) throw new Error(`Corpo sconosciuto: ${id}`);
    return b;
  }

  /**
   * Avanza la simulazione di un frame. `realDt` = secondi reali trascorsi dall'ultimo frame.
   * Il tempo simulato (realDt × timeWarp) viene suddiviso in sotto-passi ≤ maxStep.
   */
  update(realDt: number): FrameReport {
    const dtReal = Math.min(Math.max(realDt, 0), this.maxRealDt);
    const requested = this.paused ? 0 : dtReal * this.timeWarp;
    if (requested <= 0) {
      this.lastFrame = { requested: 0, simulated: 0, substeps: 0, stepSize: 0, limited: false };
      return this.lastFrame;
    }
    let substeps = Math.max(1, Math.ceil(requested / this._maxStep - 1e-9));
    let simulated = requested;
    let limited = false;
    if (substeps > this.maxSubstepsPerFrame) {
      substeps = this.maxSubstepsPerFrame;
      simulated = substeps * this._maxStep;
      limited = true;
    }
    const h = simulated / substeps;
    for (let s = 0; s < substeps; s++) this.system.step(h, this.integrator);
    this.time += simulated;
    this.lastFrame = { requested, simulated, substeps, stepSize: h, limited };
    return this.lastFrame;
  }

  /** Avanza di `seconds` senza limiti di budget (per test, pre-calcoli, "salta a data"). */
  advance(seconds: number, maxStep = this._maxStep): void {
    if (seconds <= 0) return;
    const n = Math.max(1, Math.ceil(seconds / maxStep - 1e-9));
    const h = seconds / n;
    for (let s = 0; s < n; s++) this.system.step(h, this.integrator);
    this.time += seconds;
  }

  // ───────────── Stato dei corpi ─────────────

  position(id: string): Vec3 {
    return this.system.getPosition(this.get(id).index);
  }

  velocity(id: string): Vec3 {
    return this.system.getVelocity(this.get(id).index);
  }

  acceleration(id: string): Vec3 {
    return this.system.getAcceleration(this.get(id).index);
  }

  relativeState(id: string, refId: string): { r: Vec3; v: Vec3 } {
    return {
      r: this.position(id).sub(this.position(refId)),
      v: this.velocity(id).sub(this.velocity(refId)),
    };
  }

  /** Baricentro (posizione, velocità) di un corpo insieme alle sue lune. */
  systemBarycenter(id: string): { r: Vec3; v: Vec3; gm: number } {
    const members = this.bodies.filter((b) => b.id === id || b.parentId === id);
    const r = new Vec3();
    const v = new Vec3();
    let gm = 0;
    for (const b of members) {
      r.addScaledInPlace(this.system.getPosition(b.index), b.gm);
      v.addScaledInPlace(this.system.getVelocity(b.index), b.gm);
      gm += b.gm;
    }
    return { r: r.scale(1 / gm), v: v.scale(1 / gm), gm };
  }

  /**
   * Corpo gravitazionalmente dominante per `id`: quello con la sfera d'influenza più piccola
   * che contiene il corpo (il Sole ha SOI infinita).
   */
  dominantBody(id: string): SimBody {
    const self = this.get(id);
    const p = this.system.getPosition(self.index);
    let best: SimBody | null = null;
    for (const b of this.bodies) {
      if (b === self || b.gm <= 0) continue;
      if (best && b.soi >= best.soi) continue;
      if (p.distanceTo(this.system.getPosition(b.index)) < b.soi) best = b;
    }
    if (!best) throw new Error('Nessun corpo dominante trovato');
    return best;
  }

  /** Orbita osculante di `id` attorno a `refId` (default: corpo dominante). */
  orbit(id: string, refId?: string): OrbitInfo {
    const body = this.get(id);
    const ref = refId ? this.get(refId) : this.dominantBody(id);
    const { r, v } = this.relativeState(id, ref.id);
    return stateToElements(r, v, ref.gm + body.gm);
  }

  /** Pacchetto completo di telemetria. */
  telemetry(id: string, refId?: string): Telemetry {
    const body = this.get(id);
    const ref = refId ? this.get(refId) : this.dominantBody(id);
    const { r, v } = this.relativeState(id, ref.id);
    const orbit = stateToElements(r, v, ref.gm + body.gm);
    const acceleration = this.acceleration(id);
    const distance = r.length();
    return {
      id,
      refId: ref.id,
      time: this.time,
      relPosition: r,
      relVelocity: v,
      distance,
      altitude: distance - ref.radius,
      speed: v.length(),
      acceleration,
      accelerationMagnitude: acceleration.length(),
      orbit,
      periapsisAltitude: orbit.periapsis - ref.radius,
      apoapsisAltitude: orbit.apoapsis - ref.radius,
    };
  }

  /**
   * Riporta i corpi naturali allo stato del catalogo al tempo t [s da J2000]
   * (es. pulsante "LIVE": sincronizza la simulazione con l'ora reale).
   * Le particelle di prova (sonde) non vengono modificate.
   */
  resetToTime(t: number): void {
    for (const s of buildInitialStates(this.catalog, t)) {
      const b = this.byId.get(s.def.id);
      if (b) this.system.setState(b.index, s.r, s.v);
    }
    this.time = t;
  }

  resetToDate(date: Date = new Date()): void {
    this.resetToTime(simTimeFromDate(date));
  }

  /** Aggiunge una particella di prova (sonda/razzo) con stato baricentrico dato. */
  addProbe(id: string, name: string, r: Vec3, v: Vec3): SimBody {
    if (this.byId.has(id)) throw new Error(`Id già in uso: ${id}`);
    const index = this.system.addBody(0, r, v);
    const b: SimBody = { id, name, kind: 'probe', def: null, parentId: null, index, gm: 0, radius: 0, soi: 0 };
    this.register(b);
    return b;
  }

  /** Energia meccanica totale [J] (diagnostica della precisione dell'integratore). */
  totalEnergy(): number {
    return this.system.totalEnergy();
  }
}
