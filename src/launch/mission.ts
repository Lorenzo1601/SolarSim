/**
 * LaunchMission — una missione di lancio "vera" simulata in tempo reale (o accelerato):
 *   conto alla rovescia → salita fisica (AscentVehicle) → inserimento in orbita di parcheggio →
 *   manovre in orbita con motori a spinta finita → crociera N-body → arrivo (flyby o inserimento).
 *
 * Tipi di missione: LEO, SSO, GTO, GEO, Luna (flyby o orbita), pianeti (flyby o orbita).
 * Tutte le manovre sono calcolate a bordo al momento opportuno (come fa un vero centro di controllo):
 *   - circolarizzazioni all'apogeo;
 *   - iniezione in GTO al passaggio per l'equatore;
 *   - iniezione translunare (TLI) cercata con un predittore N-body;
 *   - fuga interplanetaria nel punto dell'orbita che allinea l'asintoto di partenza;
 *   - correzioni di rotta (Lambert verso un punto di mira, poi correzione nel piano B);
 *   - frenata di inserimento al periasse.
 */
import { DAY } from '../physics/constants.ts';
import { stateToElements } from '../physics/kepler.ts';
import type { Simulation } from '../physics/simulation.ts';
import { Vec3 } from '../physics/vec3.ts';
import { temeToEclipticMatrix } from '../spacecraft/teme.ts';
import { AscentVehicle, DEG_RAD, type AscentTelemetry, type FlightEvent } from './ascent.ts';
import { G0, MU_EARTH, R_EQ, R_GEO, geodeticToEcef, gmst, groundVelocity, rotZ } from './earthModel.ts';
import { MU_SUN, eciToEcliptic, eclipticToEci, hyperbolicVelocity, lambert, type TransferPlan } from './planner.ts';
import { GravityField, Predictor, ProbePropagator, type BodiesSnapshot } from './propagator.ts';
import type { LaunchSite, RocketDef } from './rockets.ts';

export type MissionType = 'leo' | 'sso' | 'gto' | 'geo' | 'moon' | 'planet';

export interface PayloadDef {
  name: string;
  /** Massa totale al lancio (incluso il propellente del satellite) [kg]. */
  mass: number;
  /** Propellente del sistema propulsivo del satellite [kg]. */
  propellant: number;
  thrust: number;
  isp: number;
}

export interface MissionConfig {
  rocket: RocketDef;
  site: LaunchSite;
  payload: PayloadDef;
  type: MissionType;
  /** Quota finale (LEO/SSO) [m]. */
  altitude: number;
  /** Inclinazione (LEO) o inclinazione dell'orbita di parcheggio [rad]. */
  inclination: number;
  southward: boolean;
  recovery: boolean;
  maxAccelG: number;
  maxQ: number;
  pitchKick: number;
  parkingAltitude: number;
  /** Istante del decollo (T0) [s da J2000]. */
  launchTime: number;
  /** Luna/pianeti: flyby o inserimento in orbita, quota del periasse [m]. */
  arrivalMode: 'flyby' | 'orbit';
  arrivalAltitude: number;
  /** Pianeta obiettivo e piano di trasferimento (missioni interplanetarie). */
  target?: string;
  transfer?: TransferPlan;
}

export type MissionPhase = 'countdown' | 'ascent' | 'orbit' | 'complete' | 'failed';

interface Engine {
  name: string;
  prop: number;
  thrust: number;
  isp: number;
}

type BurnDirection =
  | { kind: 'prograde' | 'retrograde' | 'horizontal'; body: string }
  | { kind: 'target'; velocity: Vec3 }
  /** Manovra "impulsiva equivalente": insegue il Δv vettoriale residuo (Δv comandato − Δv già dato). */
  | { kind: 'deltav'; dv: Vec3 }
  /** Frenata di cattura: retrograda, con componente radiale se il periasse scende sotto la quota sicura. */
  | { kind: 'capture'; body: string; mu: number; minPeri: number }
  /** Iniezione di fuga: guida "velocità da guadagnare" verso l'iperbole con asintoto v∞ assegnato. */
  | { kind: 'hyperbola'; vInf: Vec3; vg?: Vec3 };

interface ActiveBurn {
  name: string;
  engine: 'upper' | 'payload';
  dir: BurnDirection;
  /** Δv obiettivo (se definito) [m/s]. */
  dv?: number;
  stop?: () => boolean;
  started: number;
  mass0: number;
}

interface ScheduledEvent {
  t: number;
  name: string;
  run: () => void;
}

export interface TelemetrySample {
  /** Secondi dal decollo. */
  t: number;
  alt: number;
  v: number;
  q: number;
  acc: number;
  mass: number;
}

export interface MissionTelemetry {
  met: number;
  phase: string;
  ref: string;
  altitude: number;
  speed: number;
  verticalSpeed?: number;
  accelG: number;
  q?: number;
  mach?: number;
  mass: number;
  throttle?: number;
  thrust: number;
  stage: string;
  propFraction?: number;
  apoapsis: number;
  periapsis: number;
  inclination: number;
  eccentricity: number;
  period: number;
  distEarth: number;
  distSun: number;
  lat?: number;
  lon?: number;
  downrange?: number;
  dvRemaining: number;
  upperProp: number;
  payloadProp: number;
  nextEvent?: { name: string; in: number };
  burning?: string;
}

const MOON_SOI = 66_100e3;

export class LaunchMission {
  readonly cfg: MissionConfig;
  readonly sim: Simulation;
  phase: MissionPhase = 'countdown';
  events: FlightEvent[] = [];
  history: TelemetrySample[] = [];
  /** Traccia della traiettoria: posizioni relative a un corpo (per il disegno). */
  trail: { body: string; rel: Vec3; t: number }[] = [];
  /** Inizio del tratto di orbita chiusa corrente (per sfoltire la scia dei giri già percorsi). */
  private boundSince: { body: string; t: number } | null = null;
  private trailPushes = 0;
  ascent: AscentVehicle | null = null;
  prop: ProbePropagator | null = null;
  upper: Engine | null = null;
  upperDry = 0;
  payloadProp: number;
  payloadSeparated = false;
  burn: ActiveBurn | null = null;
  schedule: ScheduledEvent[] = [];
  /** Stato assoluto corrente (eclittica, baricentrico) per la grafica. */
  position = new Vec3();
  velocity = new Vec3();
  private field: GravityField | null = null;
  private lastSample = -Infinity;
  private closest: { body: string; d: number; t: number } | null = null;
  private inTargetSoi = false;
  private lastTel: MissionTelemetry | null = null;
  private approachDone = false;
  private periapsisHandled = false;
  private captureStarted = false;

  constructor(sim: Simulation, cfg: MissionConfig) {
    this.sim = sim;
    // il propellente del satellite non può superare il 90% della sua massa totale
    this.cfg = { ...cfg, payload: { ...cfg.payload, propellant: Math.max(0, Math.min(cfg.payload.propellant, cfg.payload.mass * 0.9)) } };
    this.payloadProp = this.cfg.payload.propellant;
    this.log(0, 'info', `Missione pronta: ${cfg.rocket.name} da ${cfg.site.name}`);
  }

  get met(): number {
    return this.sim.time - this.cfg.launchTime;
  }

  private log(t: number, kind: FlightEvent['kind'], text: string): void {
    this.events.push({ t, kind, text });
  }

  // ───────────────────────── Aggiornamento ─────────────────────────

  /** Avanza la missione fra due fotografie dei corpi (inizio e fine del frame). */
  update(a: BodiesSnapshot, b: BodiesSnapshot): void {
    if (this.phase === 'failed') return;
    const T0 = this.cfg.launchTime;
    if (b.t < T0) {
      this.phase = 'countdown';
      this.placeOnPad(b.t);
      return;
    }
    if (this.phase === 'countdown') {
      this.phase = 'ascent';
      const c = this.cfg;
      this.ascent = new AscentVehicle({
        rocket: c.rocket,
        payloadMass: c.payload.mass,
        site: c.site,
        targetAltitude: this.insertionPerigee(),
        targetApoapsis: this.insertionApogee(),
        inclination: c.inclination,
        southward: c.southward,
        maxAccelG: c.maxAccelG,
        maxQ: c.maxQ,
        pitchKick: c.pitchKick,
        pitchStartSpeed: 50,
        recovery: c.recovery,
        theta0: gmst(T0),
      });
    }
    if (this.phase === 'ascent' && this.ascent) {
      const target = b.t - T0;
      const asc = this.ascent;
      let guard = 0;
      while (asc.t < target - 1e-6 && guard++ < 200000) {
        asc.step(Math.min(0.1, target - asc.t));
        if (asc.t - this.lastSample >= 1) this.sampleAscent(asc.telemetry());
        if (asc.phase === 'orbit' || asc.phase === 'crashed') break;
      }
      this.syncAscentEvents();
      this.updateAscentPosition(T0 + asc.t);
      if (asc.phase === 'crashed' || asc.phase === 'suborbital') {
        if (asc.phase === 'crashed') {
          this.phase = 'failed';
          return;
        }
        if (asc.t >= target - 1e-6) return; // continua in balistico finché non tocca terra
      }
      if (asc.phase === 'orbit') this.enterOrbit(a, b);
      else return;
    }
    if (this.phase === 'orbit' || this.phase === 'complete') this.propagateOrbit(a, b);
  }

  private insertionPerigee(): number {
    const c = this.cfg;
    if (c.type === 'leo' || c.type === 'sso') return Math.min(c.altitude, Math.max(c.parkingAltitude, 180e3));
    return c.parkingAltitude;
  }

  private insertionApogee(): number {
    const c = this.cfg;
    if (c.type === 'leo' || c.type === 'sso') return c.altitude;
    return c.parkingAltitude;
  }

  private placeOnPad(t: number): void {
    // sulla rampa: punto dell'ellissoide terrestre che ruota con la Terra
    const site = this.cfg.site;
    const eci = rotZ(geodeticToEcef(site.lat, site.lon, site.alt), gmst(t));
    const M = temeToEclipticMatrix(t);
    this.position = this.sim.position('earth').add(eciToEcliptic(eci, M));
    this.velocity = this.sim.velocity('earth').add(eciToEcliptic(groundVelocity(eci), M));
  }

  private updateAscentPosition(t: number): void {
    const asc = this.ascent!;
    const M = temeToEclipticMatrix(t);
    const rel = eciToEcliptic(asc.r, M);
    this.position = this.sim.position('earth').add(rel);
    this.velocity = this.sim.velocity('earth').add(eciToEcliptic(asc.v, M));
    this.pushTrail('earth', rel);
  }

  private pushTrail(body: string, rel: Vec3, vrel?: Vec3, t = this.sim.time): void {
    const last = this.trail[this.trail.length - 1];
    if (last && last.body === body && last.rel.distanceTo(rel) < rel.length() * 0.002) return;
    this.trail.push({ body, rel, t });
    // In orbita chiusa si conservano solo l'ultimo giro (e mezzo) e ciò che precede la cattura:
    // dopo centinaia di rivoluzioni la scia diventerebbe un groviglio illeggibile.
    if (vrel && body !== 'sun') {
      const o = stateToElements(rel, vrel, this.muOf(body));
      if (o.isBound && Number.isFinite(o.period)) {
        if (!this.boundSince || this.boundSince.body !== body) this.boundSince = { body, t };
        if (++this.trailPushes % 25 === 0) {
          const from = this.boundSince.t;
          const keepAfter = t - 1.5 * o.period;
          this.trail = this.trail.filter((p) => p.body !== body || p.t <= from || p.t >= keepAfter);
        }
      } else this.boundSince = null;
    } else this.boundSince = null;
    if (this.trail.length > 6000) this.trail = this.trail.filter((_, i) => i % 2 === 0 || i === this.trail.length - 1);
  }


  private syncAscentEvents(): void {
    const asc = this.ascent!;
    for (const e of asc.events) {
      if (!this.events.some((x) => x.t === e.t && x.text === e.text)) this.events.push(e);
    }
    this.events.sort((x, y) => x.t - y.t);
  }

  private sampleAscent(tel: AscentTelemetry): void {
    this.lastSample = tel.t;
    this.history.push({ t: tel.t, alt: tel.altitude, v: tel.speed, q: tel.q, acc: tel.accelG, mass: tel.mass });
    if (this.history.length > 4000) this.history = this.history.filter((_, i) => i % 2 === 0);
  }

  // ───────────────────────── Inserimento e pianificazione ─────────────────────────

  private enterOrbit(a: BodiesSnapshot, b: BodiesSnapshot): void {
    const asc = this.ascent!;
    const t = this.cfg.launchTime + asc.t;
    const M = temeToEclipticMatrix(t);
    this.field = new GravityField(this.sim, a, b);
    const e = this.field.earth(t);
    const r = e.r.add(eciToEcliptic(asc.r, M));
    const v = e.v.add(eciToEcliptic(asc.v, M));
    const up = asc.upperStage();
    this.upper = up ? { name: up.name, prop: up.prop, thrust: up.thrust, isp: up.isp } : null;
    this.upperDry = up ? up.dry : 0;
    const m = this.cfg.payload.mass + (up ? up.dry + up.prop : 0);
    this.prop = new ProbePropagator({ t, r, v, m });
    this.prop.shape = { area: Math.PI * (this.cfg.rocket.diameter / 2) ** 2, cd: 2.2 };
    this.phase = 'orbit';
    this.planAfterInsertion(t);
  }

  private at(t: number, name: string, run: () => void): void {
    this.schedule.push({ t, name, run });
    this.schedule.sort((x, y) => x.t - y.t);
  }

  private relTo(body: string): { r: Vec3; v: Vec3; mu: number } {
    const s = this.prop!.state;
    const f = this.field!;
    const bi = this.sim.get(body);
    const bs = f.body(bi.index, s.t);
    return { r: s.r.sub(bs.r), v: s.v.sub(bs.v), mu: bi.gm };
  }

  /** Tempo per raggiungere l'anomalia vera ν (orbita ellittica relativa a `body`). */
  private timeToTrueAnomaly(body: string, nu: number): number {
    const { r, v, mu } = this.relTo(body);
    const o = stateToElements(r, v, mu);
    const E = 2 * Math.atan2(Math.sqrt(1 - o.e) * Math.sin(nu / 2), Math.sqrt(1 + o.e) * Math.cos(nu / 2));
    const M = E - o.e * Math.sin(E);
    const n = Math.sqrt(mu / Math.abs(o.a) ** 3);
    let dM = M - o.M;
    while (dM < 0) dM += 2 * Math.PI;
    return dM / n;
  }

  private separatePayload(t: number): void {
    if (this.payloadSeparated || !this.prop) return;
    this.payloadSeparated = true;
    const upperMass = this.upperDry + (this.upper?.prop ?? 0);
    this.prop.state = { ...this.prop.state, m: Math.max(1, this.prop.state.m - upperMass) };
    this.log(t - this.cfg.launchTime, 'separation', `Separazione del carico: ${this.cfg.payload.name}`);
    this.upper = null;
  }

  private complete(t: number, text: string): void {
    this.phase = 'complete';
    this.log(t - this.cfg.launchTime, 'orbit', text);
  }

  private burnTime(dv: number, engine: Engine, mass: number): number {
    const ve = engine.isp * G0;
    const mdot = engine.thrust / ve;
    return (mass / mdot) * (1 - Math.exp(-dv / ve));
  }

  private planAfterInsertion(t: number): void {
    const c = this.cfg;
    const met = (x: number) => x - c.launchTime;
    const rel = this.relTo('earth');
    const o = stateToElements(rel.r, rel.v, MU_EARTH);

    if (c.type === 'leo' || c.type === 'sso') {
      if (c.altitude > this.insertionPerigee() + 20e3) {
        const tApo = t + this.timeToTrueAnomaly('earth', Math.PI);
        const rT = R_EQ + c.altitude;
        const dv = Math.sqrt(MU_EARTH / rT) - Math.sqrt(MU_EARTH * (2 / rT - 1 / o.a));
        const tb = this.burnTime(dv, this.upper!, this.prop!.state.m);
        this.at(tApo - tb / 2, 'Circolarizzazione all\'apogeo', () =>
          this.startBurn('Circolarizzazione', 'upper', { kind: 'horizontal', body: 'earth' }, undefined, () => {
            const r2 = this.relTo('earth');
            const e2 = stateToElements(r2.r, r2.v, MU_EARTH);
            return e2.e < 0.0008 || e2.periapsis >= Math.min(rT, r2.r.length()) - 1e3;
          }, () => this.finishLeo()));
      } else this.at(t + 60, 'Separazione del carico', () => this.finishLeo());
      return;
    }

    if (c.type === 'gto' || c.type === 'geo') {
      // passaggio per l'equatore (nodo): argomento di latitudine u = 0 o π nel frame ECI
      const M = temeToEclipticMatrix(t);
      const rE = eclipticToEci(rel.r, M);
      const vE = eclipticToEci(rel.v, M);
      const oe = stateToElements(rE, vE, MU_EARTH);
      const nuAsc = (2 * Math.PI - oe.argp) % (2 * Math.PI);
      const n = Math.sqrt(MU_EARTH / oe.a ** 3);
      const dtNode = (nu: number) => {
        let d = nu - oe.nu;
        while (d < 60 / 5400 * 2 * Math.PI) d += 2 * Math.PI;
        return d / n;
      };
      const tNode = t + Math.min(dtNode(nuAsc), dtNode((nuAsc + Math.PI) % (2 * Math.PI)));
      const dv = Math.sqrt(MU_EARTH * (2 / o.a - 2 / (o.a + R_GEO))) - Math.sqrt(MU_EARTH / o.a);
      const tb = this.burnTime(dv, this.upper!, this.prop!.state.m);
      this.at(tNode - tb / 2, 'Iniezione in orbita di trasferimento geostazionaria (GTO)', () =>
        this.startBurn('Iniezione in GTO', 'upper', { kind: 'prograde', body: 'earth' }, undefined, () => {
          const r2 = this.relTo('earth');
          return stateToElements(r2.r, r2.v, MU_EARTH).apoapsis >= R_GEO;
        }, (tEnd) => {
          this.separatePayload(tEnd);
          if (c.type === 'gto') {
            const r2 = this.relTo('earth');
            const e2 = stateToElements(r2.r, r2.v, MU_EARTH);
            this.complete(tEnd, `GTO raggiunta: ${((e2.periapsis - R_EQ) / 1e3).toFixed(0)} × ${((e2.apoapsis - R_EQ) / 1e3).toFixed(0)} km`);
          } else this.planGeoInsertion(tEnd);
        }));
      void met;
      return;
    }

    if (c.type === 'moon') {
      this.planTli(t);
      return;
    }

    if (c.type === 'planet') this.planDeparture(t);
  }

  private apogeeTrimmed = false;

  private finishLeo(): void {
    const t = this.prop!.state.t;
    // apogeo troppo alto (es. stadio a solido che ha dato troppa energia): abbassalo al perigeo
    const rT = R_EQ + this.cfg.altitude;
    const r0 = this.relTo('earth');
    const o0 = stateToElements(r0.r, r0.v, MU_EARTH);
    if (!this.apogeeTrimmed && this.upper && this.upper.prop > 0 && o0.apoapsis > rT + 20e3) {
      this.apogeeTrimmed = true;
      const tPeri = t + this.timeToTrueAnomaly('earth', 0);
      this.at(tPeri, 'Abbassamento dell\'apogeo', () =>
        this.startBurn('Abbassamento dell\'apogeo', 'upper', { kind: 'retrograde', body: 'earth' }, undefined, () => {
          const r2 = this.relTo('earth');
          return stateToElements(r2.r, r2.v, MU_EARTH).apoapsis <= rT + 5e3;
        }, () => this.finishLeo()));
      return;
    }
    this.separatePayload(t);
    const r = this.relTo('earth');
    const M = temeToEclipticMatrix(t);
    const oe = stateToElements(eclipticToEci(r.r, M), eclipticToEci(r.v, M), MU_EARTH);
    this.complete(t, `Satellite in orbita: ${((oe.periapsis - R_EQ) / 1e3).toFixed(0)} × ${((oe.apoapsis - R_EQ) / 1e3).toFixed(0)} km, inclinazione ${(oe.i / DEG_RAD).toFixed(2)}°`);
  }

  /**
   * Inserimento in GEO con il motore del satellite: più accensioni all'apogeo (al massimo 50 minuti
   * ciascuna), come fanno i satelliti reali con i motori da ~400 N. Ogni accensione punta alla velocità
   * di un'orbita equatoriale con apsidi (r, R_GEO): alza il perigeo e azzera l'inclinazione.
   */
  private geoBurns = 0;

  private planGeoInsertion(t: number): void {
    const rel = this.relTo('earth');
    const o = stateToElements(rel.r, rel.v, MU_EARTH);
    const tApo = t + this.timeToTrueAnomaly('earth', Math.PI);
    const maxBurn = 50 * 60;
    if (this.geoBurns === 0) {
      const vApo = Math.sqrt(MU_EARTH * (2 / R_GEO - 1 / o.a));
      const dvGeo = Math.sqrt(Math.max(0, vApo ** 2 + MU_EARTH / R_GEO - 2 * vApo * Math.sqrt(MU_EARTH / R_GEO) * Math.cos(this.cfg.inclination)));
      const eng = this.engineFor('payload')!;
      const tb = eng.thrust > 0 ? this.burnTime(dvGeo, eng, this.prop!.state.m) : 0;
      this.log(t - this.cfg.launchTime, 'info', `Manovre di apogeo previste: Δv ${dvGeo.toFixed(0)} m/s, ${Math.max(1, Math.ceil(tb / maxBurn))} accensioni`);
    }
    this.geoBurns++;
    const n = this.geoBurns;
    this.at(tApo - maxBurn / 2, `Manovra di apogeo n. ${n} (motore del satellite)`, () => {
      const t0 = this.prop!.state.t;
      const target = () => {
        const s = this.prop!.state;
        const r = this.relTo('earth');
        const e = this.field!.earth(s.t);
        const pole = eciToEcliptic(new Vec3(0, 0, 1), temeToEclipticMatrix(s.t));
        const dir = pole.cross(r.r).normalize();
        const rr = r.r.length();
        const speed = Math.sqrt(MU_EARTH * (2 / rr - 2 / (rr + R_GEO)));
        return e.v.add(dir.scale(speed));
      };
      this.startBurn(`Apogeo n. ${n}: alzata del perigeo e cambio di piano`, 'payload', { kind: 'target', velocity: target() }, undefined, () =>
        target().sub(this.prop!.state.v).length() < 1 || this.prop!.state.t - t0 > maxBurn,
      (tEnd) => {
        const r = this.relTo('earth');
        const M = temeToEclipticMatrix(tEnd);
        const oe = stateToElements(eclipticToEci(r.r, M), eclipticToEci(r.v, M), MU_EARTH);
        const done = target().sub(this.prop!.state.v).length() < 5 || this.payloadProp <= 0 || n >= 8;
        if (done) {
          this.complete(tEnd, `Orbita geostazionaria: ${((oe.periapsis - R_EQ) / 1e3).toFixed(0)} × ${((oe.apoapsis - R_EQ) / 1e3).toFixed(0)} km, i = ${(oe.i / DEG_RAD).toFixed(2)}°`);
        } else {
          this.log(tEnd - this.cfg.launchTime, 'info', `Orbita intermedia: ${((oe.periapsis - R_EQ) / 1e3).toFixed(0)} × ${((oe.apoapsis - R_EQ) / 1e3).toFixed(0)} km, i = ${(oe.i / DEG_RAD).toFixed(2)}°`);
          this.planGeoInsertion(tEnd);
        }
      }, target);
    });
  }

  // ── Luna ──

  /**
   * Distanza minima (e istante) da `body` prevista con il predittore N-body, applicando al tempo
   * tBurn il Δv `dvVec` (vettore o funzione dello stato geocentrico).
   */
  private predictClosest(
    body: string,
    tBurn: number,
    dvVec: Vec3 | ((r: Vec3, v: Vec3) => Vec3),
    horizon: number,
    dt = 120,
  ): { d: number; t: number } {
    const s = this.prop!.state;
    const include = body === 'moon' ? ['sun', 'earth', 'moon', 'venus', 'jupiter'] : undefined;
    const pr = new Predictor(this.sim, s.r, s.v, include, { field: this.field!, t: s.t });
    const iE = pr.index('earth');
    const iT = pr.index(body);
    if (tBurn > pr.t) pr.run(tBurn - pr.t, 10);
    const r = pr.pos(pr.probe);
    const v = pr.vel(pr.probe);
    const dv = typeof dvVec === 'function' ? dvVec(r.sub(pr.pos(iE)), v.sub(pr.vel(iE))) : dvVec;
    pr.system.setState(pr.probe, r, v.add(dv));
    let best = { d: Infinity, t: pr.t };
    const track = (t: number) => {
      const d = pr.pos(pr.probe).distanceTo(pr.pos(iT));
      if (d < best.d) best = { d, t };
      return false;
    };
    if (body === 'moon' && pr.pos(pr.probe).distanceTo(pr.pos(iE)) < 50e6) pr.run(2 * 3600, 20, track);
    pr.run(horizon, dt, (t) => {
      track(t);
      // vicino al bersaglio: passo fine per non "saltare" il periasse
      return false;
    });
    // raffinamento attorno al minimo con passo fine
    if (Number.isFinite(best.d)) {
      const pr2 = new Predictor(this.sim, s.r, s.v, include, { field: this.field!, t: s.t });
      if (tBurn > pr2.t) pr2.run(tBurn - pr2.t, 10);
      pr2.system.setState(pr2.probe, pr2.pos(pr2.probe), pr2.vel(pr2.probe).add(dv));
      const tStart = Math.max(pr2.t, best.t - 3 * dt);
      if (tStart > pr2.t) pr2.run(tStart - pr2.t, dt);
      const i2 = pr2.index(body);
      pr2.run(6 * dt, dt / 30, () => {
        const d = pr2.pos(pr2.probe).distanceTo(pr2.pos(i2));
        if (d < best.d) best = { d, t: pr2.t };
        return false;
      });
    }
    return best;
  }

  private planTli(t: number): void {
    const moon = this.sim.get('moon');
    const rel = this.relTo('earth');
    const rp = rel.r.length();
    const period = 2 * Math.PI * Math.sqrt(rp ** 3 / MU_EARTH);
    const rMoon = this.sim.position('moon').distanceTo(this.sim.position('earth'));
    const aT = (rp + rMoon) / 2;
    const dvH = Math.sqrt(MU_EARTH * (2 / rp - 1 / aT)) - Math.sqrt(MU_EARTH / rp);
    const target = moon.radius + this.cfg.arrivalAltitude;
    const prograde = (dv: number) => (_r: Vec3, v: Vec3) => v.normalize().scale(dv);
    // 1) ricerca grossolana del punto di accensione lungo l'orbita di parcheggio
    let best = { tau: 0, dv: dvH, d: Infinity };
    for (let k = 0; k < 24; k++) {
      const tau = 300 + (period * k) / 24;
      const p = this.predictClosest('moon', t + tau, prograde(dvH), 4.5 * DAY);
      if (p.d < best.d) best = { tau, dv: dvH, d: p.d };
    }
    // 2) raffinamento (tau, dv) per il perilunio desiderato
    let step = { tau: period / 48, dv: 10 };
    const cost = (tau: number, dv: number) => {
      const p = this.predictClosest('moon', t + tau, prograde(dv), 4.5 * DAY);
      return Math.abs(p.d - target);
    };
    let c0 = cost(best.tau, best.dv);
    for (let it = 0; it < 16 && (step.tau > 4 || step.dv > 0.5); it++) {
      let improved = false;
      for (const [dt, dd] of [[step.tau, 0], [-step.tau, 0], [0, step.dv], [0, -step.dv]]) {
        const c1 = cost(best.tau + dt, best.dv + dd);
        if (c1 < c0) {
          c0 = c1;
          best = { tau: best.tau + dt, dv: best.dv + dd, d: c1 };
          improved = true;
        }
      }
      if (!improved) step = { tau: step.tau / 2, dv: step.dv / 2 };
    }
    const tb = this.burnTime(best.dv, this.upper!, this.prop!.state.m);
    this.log(t - this.cfg.launchTime, 'info', `TLI pianificata: Δv ${best.dv.toFixed(0)} m/s, accensione tra ${((best.tau - tb / 2) / 60).toFixed(1)} min`);
    this.at(t + best.tau - tb / 2, 'Iniezione translunare (TLI)', () =>
      this.startBurn('TLI', 'upper', { kind: 'prograde', body: 'earth' }, best.dv, undefined, (tEnd) => {
        this.separatePayload(tEnd);
        this.at(tEnd + 12 * 3600, 'Correzione di rotta (MCC-1)', () => this.lunarCorrection());
        this.at(tEnd + 40 * 3600, 'Correzione di rotta (MCC-2)', () => this.lunarCorrection());
      }));
  }

  /** Correzione di rotta verso il periasse obiettivo (Newton a norma minima sul Δv, predittore N-body). */
  private targetedCorrection(name: string, body: string, horizon: number, dt: number): void {
    const s = this.prop!.state;
    const target = this.sim.get(body).radius + this.cfg.arrivalAltitude;
    const f = (dv: Vec3) => this.predictClosest(body, s.t, dv, horizon, dt).d - target;
    let dv = new Vec3();
    for (let it = 0; it < 6; it++) {
      const f0 = f(dv);
      if (Math.abs(f0) < Math.max(2e3, target * 0.01)) break;
      const h = 0.2;
      const g = new Vec3((f(dv.add(new Vec3(h, 0, 0))) - f0) / h, (f(dv.add(new Vec3(0, h, 0))) - f0) / h, (f(dv.add(new Vec3(0, 0, h))) - f0) / h);
      const g2 = g.lengthSq();
      if (g2 === 0) break;
      const step = g.scale(-f0 / g2);
      dv = dv.add(step.length() > 100 ? step.normalize().scale(100) : step);
    }
    if (dv.length() < 0.05) {
      this.log(s.t - this.cfg.launchTime, 'info', `${name}: non necessaria, traiettoria nominale`);
      return;
    }
    this.correction(name, dv);
  }

  private lunarCorrection(): void {
    this.targetedCorrection('Correzione di rotta', 'moon', 4 * DAY, 120);
  }

  // ── Pianeti ──

  /** Posizione di mira relativa al pianeta all'arrivo: parametro d'impatto b perpendicolare a v∞. */
  private aimOffset(): Vec3 {
    const target = this.cfg.target!;
    const planet = this.sim.get(target);
    const mu = this.muOf(target);
    const vInfArr = this.cfg.transfer?.vInfArr ?? new Vec3(1, 0, 0);
    const vInf = vInfArr.length();
    const rp = planet.radius + this.cfg.arrivalAltitude;
    const b = rp * Math.sqrt(1 + (2 * mu) / (rp * vInf * vInf));
    // lato scelto per un'orbita di arrivo prograda (momento angolare verso il nord dell'eclittica)
    const side = vInfArr.normalize().cross(new Vec3(0, 0, 1)).normalize();
    return side.scale(b);
  }

  /** Posizione relativa al pianeta all'istante d'arrivo, con Δv applicato ora (gravità del pianeta esclusa). */
  private predictMiss(dv: Vec3, tArr: number): Vec3 {
    const s = this.prop!.state;
    const target = this.cfg.target!;
    const pr = new Predictor(this.sim, s.r, s.v.add(dv), undefined, { field: this.field!, t: s.t }, [target]);
    const nearEarth = s.r.distanceTo(this.field!.earth(s.t).r) < 3e9;
    const total = tArr - s.t;
    if (nearEarth) pr.run(Math.min(2 * DAY, total), 60);
    if (tArr > pr.t) pr.run(tArr - pr.t, Math.max(600, (tArr - pr.t) / 4000));
    return pr.pos(pr.probe).sub(pr.pos(pr.index(target)));
  }

  /** Correzione di rotta interplanetaria: Newton 3×3 sul Δv per centrare il punto di mira. */
  private aimCorrection(name: string, engine: 'upper' | 'payload'): void {
    const s = this.prop!.state;
    const plan = this.cfg.transfer!;
    if (plan.arrival - s.t < 2 * DAY) return;
    const aim = this.aimOffset();
    const F = (dv: Vec3) => this.predictMiss(dv, plan.arrival).sub(aim);
    let dv = new Vec3();
    for (let it = 0; it < 6; it++) {
      const f0 = F(dv);
      if (f0.length() < Math.max(2e5, aim.length() * 0.05)) break;
      const h = 0.05;
      const J = [F(dv.add(new Vec3(h, 0, 0))), F(dv.add(new Vec3(0, h, 0))), F(dv.add(new Vec3(0, 0, h)))].map((c) => c.sub(f0).scale(1 / h));
      // risolve J·x = −f0 (regola di Cramer)
      const det = J[0].dot(J[1].cross(J[2]));
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
      const b = f0.scale(-1);
      const x = new Vec3(b.dot(J[1].cross(J[2])) / det, J[0].dot(b.cross(J[2])) / det, J[0].dot(J[1].cross(b)) / det);
      dv = dv.add(x.length() > 500 ? x.normalize().scale(500) : x);
    }
    if (dv.length() < 0.05) {
      this.log(s.t - this.cfg.launchTime, 'info', `${name}: non necessaria`);
      return;
    }
    if (engine === 'upper') {
      const stop = () => {
        const left = dv.sub(this.prop!.burnDvVec);
        return left.length() < 0.02 || left.dot(dv) < 0;
      };
      this.startBurn(`${name} (${dv.length().toFixed(1)} m/s)`, 'upper', { kind: 'deltav', dv }, undefined, stop, (tEnd) => this.afterDeparture(tEnd));
    } else this.correction(name, dv);
  }

  private afterDeparture(tEnd: number): void {
    const plan = this.cfg.transfer!;
    this.separatePayload(tEnd);
    this.at(tEnd + 10 * DAY, 'Correzione di rotta TCM-1', () => this.aimCorrection('TCM-1', 'payload'));
    this.at(tEnd + (plan.arrival - tEnd) / 2, 'Correzione di rotta TCM-2', () => this.aimCorrection('TCM-2', 'payload'));
    this.at(plan.arrival - 15 * DAY, 'Correzione di rotta TCM-3', () => this.aimCorrection('TCM-3', 'payload'));
  }

  private planDeparture(t: number): void {
    const plan = this.cfg.transfer;
    if (!plan) {
      this.fail(t, 'Nessun piano di trasferimento');
      return;
    }
    const rel = this.relTo('earth');
    const rp = rel.r.length();
    // v∞ ricalcolato con Lambert dalla posizione reale della Terra al punto di mira
    const earthNow = this.sim.position('earth').sub(this.sim.position('sun'));
    const vEarth = this.sim.velocity('earth').sub(this.sim.velocity('sun'));
    const target = this.cfg.target!;
    const prT = new Predictor(this.sim, rel.r, rel.v, undefined, { field: this.field!, t });
    prT.run(plan.arrival - t, Math.max(3600, (plan.arrival - t) / 3000));
    const aimPos = prT.pos(prT.index(target)).sub(prT.pos(prT.index('sun')));
    const sol = lambert(earthNow, aimPos, plan.arrival - t, MU_SUN, true);
    const vInf = sol ? sol.v1.sub(vEarth) : plan.vInfDep;
    const vi = vInf.length();
    const e = 1 + (rp * vi * vi) / MU_EARTH;
    const nuInf = Math.acos(-1 / e);
    const h = rel.r.cross(rel.v).normalize();
    const sp = vInf.sub(h.scale(vInf.dot(h))).normalize();
    // periasse = asintoto ruotato all'indietro di ν∞ attorno alla normale del piano
    const rot = (v: Vec3, ang: number) => v.scale(Math.cos(ang)).add(h.cross(v).scale(Math.sin(ang))).add(h.scale(h.dot(v) * (1 - Math.cos(ang))));
    const pDir = rot(sp, -nuInf);
    const rNow = rel.r.normalize();
    let ang = Math.atan2(h.dot(rNow.cross(pDir)), rNow.dot(pDir));
    if (ang < 0.2) ang += 2 * Math.PI;
    const n = Math.sqrt(MU_EARTH / rp ** 3);
    const dvEsc = Math.sqrt(vi * vi + (2 * MU_EARTH) / rp) - Math.sqrt(MU_EARTH / rp);
    const tb = this.burnTime(dvEsc, this.upper!, this.prop!.state.m);
    const outOfPlane = Math.asin(Math.min(1, Math.abs(vInf.normalize().dot(h))));
    this.log(t - this.cfg.launchTime, 'info', `Fuga pianificata: C3 = ${(vi * vi / 1e6).toFixed(1)} km²/s², Δv ${dvEsc.toFixed(0)} m/s, asintoto fuori piano ${(outOfPlane / DEG_RAD).toFixed(1)}°`);
    const hyp: BurnDirection = { kind: 'hyperbola', vInf };
    let lastVg: Vec3 | null = null;
    this.at(t + ang / n - tb / 2 + tb * 0.08, 'Iniezione interplanetaria', () =>
      this.startBurn('Iniezione interplanetaria', 'upper', hyp, undefined, () => {
        // spegnimento quando la velocità da guadagnare si annulla (o inverte verso rispetto alla spinta)
        const r2 = this.relTo('earth');
        const req = hyperbolicVelocity(r2.r, vInf, MU_EARTH, r2.r.cross(r2.v));
        if (!req) return r2.v.lengthSq() / 2 - MU_EARTH / r2.r.length() >= (vi * vi) / 2;
        const vg = req.sub(r2.v);
        const stopNow = vg.length() < 0.05 || (lastVg !== null && vg.dot(lastVg) < 0);
        lastVg = vg;
        return stopNow;
      }, (tEnd) => {
        // correzione immediata con lo stadio superiore ancora agganciato (vicino alla Terra costa poco)
        this.at(tEnd + 1800, 'Correzione di fuga (stadio superiore)', () => this.aimCorrection('Correzione di fuga', 'upper'));
      }));
  }

  /** Correzione finale all'ingresso nella sfera d'influenza del bersaglio (predittore N-body). */
  private approachCorrection(body: string): void {
    const rel = this.relTo(body);
    // orizzonte: poco oltre il tempo stimato al periasse
    const tp = rel.r.length() / Math.max(rel.v.length(), 1);
    this.targetedCorrection('Correzione di avvicinamento', body, tp * 1.6, Math.max(20, tp / 3000));
  }

  /** Apoasse dell'orbita di cattura e dell'orbita finale. */
  private captureApo(body: string): { capture: number; final: number } {
    const b = this.sim.get(body);
    if (body === 'moon') return { capture: b.radius + 8000e3, final: b.radius + Math.max(this.cfg.arrivalAltitude * 2, 300e3) };
    return { capture: b.radius * 20, final: b.radius * 20 };
  }

  private muOf(body: string): number {
    return this.sim.bodies.filter((x) => x.id === body || (x.parentId === body && body !== 'earth')).reduce((a, x) => a + x.gm, 0);
  }

  private lowering = 0;

  private captureBurn(body: string, lowering = false): void {
    const b = this.sim.get(body);
    const mu = this.muOf(body);
    const apo = this.captureApo(body);
    const rTargetApo = lowering ? apo.final : apo.capture;
    const t0 = this.prop!.state.t;
    const minPeri = b.radius + this.cfg.arrivalAltitude * 0.6;
    this.startBurn(lowering ? `Abbassamento dell'apoasse attorno a ${b.name}` : `Inserimento in orbita attorno a ${b.name}`, 'payload',
      { kind: 'capture', body, mu, minPeri }, undefined, () => {
        const r = this.relTo(body);
        const o = stateToElements(r.r, r.v, mu);
        return (o.isBound && o.apoapsis <= rTargetApo) || (lowering && this.prop!.state.t - t0 > 40 * 60);
      }, (tEnd) => {
        const r = this.relTo(body);
        const o = stateToElements(r.r, r.v, mu);
        const orbit = `${((o.periapsis - b.radius) / 1e3).toFixed(0)} × ${((o.apoapsis - b.radius) / 1e3).toFixed(0)} km`;
        if (!o.isBound) {
          this.log(tEnd - this.cfg.launchTime, 'failure', `Propellente insufficiente per la cattura: flyby di ${b.name}`);
          return;
        }
        if (o.apoapsis > apo.final * 1.02 && this.payloadProp > 0 && this.lowering < 10) {
          this.lowering++;
          this.log(tEnd - this.cfg.launchTime, 'info', `Orbita attorno a ${b.name}: ${orbit} — prossima accensione al periasse`);
          const tPeri = tEnd + this.timeToTrueAnomaly(body, 0);
          // accensione centrata sul periasse (al massimo 40 minuti)
          const vp = Math.sqrt(mu * (2 / o.periapsis - 1 / o.a));
          const vt = Math.sqrt((2 * mu * apo.final) / (o.periapsis * (o.periapsis + apo.final)));
          const tb = Math.min(40 * 60, this.burnTime(Math.max(0, vp - vt), this.engineFor('payload')!, this.prop!.state.m));
          this.at(tPeri - tb / 2, `Accensione al periasse attorno a ${b.name}`, () => this.captureBurn(body, true));
        } else this.complete(tEnd, `In orbita attorno a ${b.name}: ${orbit}`);
      });
  }

  // ───────────────────────── Combustioni ─────────────────────────

  private engineFor(kind: 'upper' | 'payload'): Engine | null {
    if (kind === 'upper') return this.upper;
    return { name: this.cfg.payload.name, prop: this.payloadProp, thrust: this.cfg.payload.thrust, isp: this.cfg.payload.isp };
  }

  private startBurn(
    name: string,
    engineKind: 'upper' | 'payload',
    dir: BurnDirection,
    dv?: number,
    stop?: () => boolean,
    after?: (tEnd: number) => void,
    targetFn?: () => Vec3,
  ): void {
    const eng = this.engineFor(engineKind);
    const s = this.prop!.state;
    if (!eng || eng.prop <= 0 || eng.thrust <= 0) {
      this.log(s.t - this.cfg.launchTime, 'failure', `${name}: nessun propellente disponibile`);
      after?.(s.t);
      return;
    }
    this.burn = { name, engine: engineKind, dir, dv, stop, started: s.t, mass0: s.m };
    const mdot = eng.thrust / (eng.isp * G0);
    this.prop!.burnDv = 0;
    this.prop!.burnDvVec = new Vec3();
    this.prop!.thrust = {
      thrust: eng.thrust,
      mdot,
      direction: (t, r, v) => {
        if (dir.kind === 'deltav') {
          const left = dir.dv.sub(this.prop!.burnDvVec);
          return left.lengthSq() > 0 ? left.normalize() : dir.dv.normalize();
        }
        if (dir.kind === 'target') {
          const tv = targetFn ? targetFn() : dir.velocity;
          const d = tv.sub(v);
          return d.lengthSq() > 0 ? d.normalize() : v.normalize();
        }
        if (dir.kind === 'hyperbola') {
          const es = this.field!.earth(t);
          const rel = r.sub(es.r);
          const vrel = v.sub(es.v);
          const req = hyperbolicVelocity(rel, dir.vInf, MU_EARTH, rel.cross(vrel));
          if (!req) return vrel.normalize();
          const vg = req.sub(vrel);
          dir.vg = vg;
          return vg.lengthSq() > 0 ? vg.normalize() : vrel.normalize();
        }
        const bs = this.field!.body(this.sim.get(dir.body).index, t);
        const vr = v.sub(bs.v);
        if (dir.kind === 'capture') {
          // retrograda + componente lungo il gradiente del periasse (∂r_p/∂v) quando il periasse
          // scende sotto la quota di sicurezza: evita che una lunga frenata porti all'impatto
          const rel = r.sub(bs.r);
          const rp0 = stateToElements(rel, vr, dir.mu).periapsis;
          const back = vr.normalize().scale(-1);
          // interviene solo quando il periasse scende a meno di 10 km sopra la quota minima
          const lambda = Math.max(0, Math.min(1.5, (dir.minPeri + 10e3 - rp0) / 20e3));
          if (lambda <= 0) return back;
          const hh = 0.5;
          const g = new Vec3(
            stateToElements(rel, vr.add(new Vec3(hh, 0, 0)), dir.mu).periapsis - rp0,
            stateToElements(rel, vr.add(new Vec3(0, hh, 0)), dir.mu).periapsis - rp0,
            stateToElements(rel, vr.add(new Vec3(0, 0, hh)), dir.mu).periapsis - rp0,
          );
          return g.lengthSq() > 0 ? back.add(g.normalize().scale(lambda)).normalize() : back;
        }
        if (dir.kind === 'prograde') return vr.normalize();
        if (dir.kind === 'retrograde') return vr.normalize().scale(-1);
        const rr = r.sub(bs.r).normalize();
        return vr.sub(rr.scale(vr.dot(rr))).normalize();
      },
    };
    (this.burn as ActiveBurn & { after?: (t: number) => void }).after = after;
    this.log(s.t - this.cfg.launchTime, 'burn', `Accensione: ${name} (${eng.name})`);
  }

  /** Correzione con il motore del satellite: Δv vettoriale da dare. */
  private correction(name: string, dv: Vec3): void {
    const stop = () => {
      const left = dv.sub(this.prop!.burnDvVec);
      return left.length() < 0.02 || left.dot(dv) < 0;
    };
    this.startBurn(`${name} (${dv.length().toFixed(1)} m/s)`, 'payload', { kind: 'deltav', dv }, undefined, stop);
  }

  private endBurn(reason: string): void {
    const b = this.burn as (ActiveBurn & { after?: (t: number) => void }) | null;
    if (!b || !this.prop) return;
    const s = this.prop.state;
    const used = b.mass0 - s.m;
    if (b.engine === 'upper' && this.upper) this.upper.prop = Math.max(0, this.upper.prop - used);
    else this.payloadProp = Math.max(0, this.payloadProp - used);
    this.log(s.t - this.cfg.launchTime, 'cutoff', `Spegnimento: ${b.name} — Δv ${this.prop.burnDv.toFixed(1)} m/s in ${(s.t - b.started).toFixed(0)} s${reason ? ' (' + reason + ')' : ''}`);
    this.prop.thrust = null;
    this.burn = null;
    b.after?.(s.t);
  }

  private fail(t: number, text: string): void {
    this.phase = 'failed';
    this.log(t - this.cfg.launchTime, 'failure', text);
  }

  // ───────────────────────── Propagazione in orbita ─────────────────────────

  private propagateOrbit(a: BodiesSnapshot, b: BodiesSnapshot): void {
    const prop = this.prop!;
    this.field = new GravityField(this.sim, a, b);
    let guard = 0;
    while (prop.state.t < b.t - 1e-6 && guard++ < 5000) {
      const nextEvent = this.schedule[0];
      const tStop = Math.min(b.t, nextEvent ? Math.max(nextEvent.t, prop.state.t) : b.t);
      // durante le combustioni passi piccoli: al massimo ~0,5 m/s di Δv per passo
      const aThr = prop.thrust ? prop.thrust.thrust / Math.max(prop.state.m, 1) : 0;
      let maxStep = 600;
      if (this.burn) {
        // ~0,5 m/s per passo; per le correzioni vettoriali un quarto del Δv residuo (precisione al cm/s)
        let dvStep = 0.5;
        if (this.burn.dir.kind === 'deltav') dvStep = Math.min(0.5, Math.max(0.005, this.burn.dir.dv.sub(prop.burnDvVec).length() / 4));
        if (this.burn.dir.kind === 'hyperbola' && this.burn.dir.vg) dvStep = Math.min(0.5, Math.max(0.005, this.burn.dir.vg.length() / 4));
        maxStep = Math.min(2, Math.max(0.001, dvStep / Math.max(aThr, 1e-6)));
      }
      prop.propagate(this.field, tStop, maxStep, (st) => this.afterStep(st));
      if (this.phase === 'failed') return;
      if (nextEvent && prop.state.t >= nextEvent.t - 1e-6) {
        this.schedule.shift();
        if (this.burn) this.endBurn('interrotta');
        nextEvent.run();
      }
    }
    const s = prop.state;
    this.position = s.r;
    this.velocity = s.v;
    const dom = this.dominant();
    const bs = this.field.body(this.sim.get(dom).index, s.t);
    this.pushTrail(dom, s.r.sub(bs.r), s.v.sub(bs.v), s.t);
  }

  /** Controlli dopo ogni passo di integrazione (fine combustione, eventi di avvicinamento, impatti). */
  private afterStep(s: { t: number; r: Vec3; v: Vec3; m: number }): boolean {
    const f = this.field!;
    const met = s.t - this.cfg.launchTime;
    if (s.t - this.lastSample >= Math.max(1, met / 500)) {
      const e = f.earth(s.t);
      this.lastSample = s.t;
      this.history.push({ t: met, alt: s.r.distanceTo(e.r) - R_EQ, v: s.v.sub(e.v).length(), q: 0, acc: (this.prop!.thrustAccel) / G0, mass: s.m });
      if (this.history.length > 4000) this.history = this.history.filter((_, i) => i % 2 === 0);
    }
    // combustione in corso
    if (this.burn) {
      const b = this.burn;
      const eng = this.engineFor(b.engine);
      const used = b.mass0 - s.m;
      if (eng && used >= eng.prop) {
        this.endBurn('propellente esaurito');
        return true;
      }
      if ((b.dv !== undefined && this.prop!.burnDv >= b.dv) || b.stop?.()) {
        this.endBurn('');
        return true;
      }
    }
    // impatto
    for (const id of ['earth', 'moon', this.cfg.target ?? '']) {
      if (!id || !this.sim.has(id)) continue;
      const body = this.sim.get(id);
      const p = f.body(body.index, s.t).r;
      const d = s.r.distanceTo(p);
      if (d < body.radius && !(id === 'earth' && met < 1000 && this.phase !== 'orbit')) {
        this.fail(s.t, `Impatto su ${body.name}`);
        return true;
      }
    }
    // arrivo a Luna / pianeta
    const targetId = this.cfg.type === 'moon' ? 'moon' : this.cfg.type === 'planet' ? this.cfg.target : undefined;
    if (targetId && this.payloadSeparated) {
      const body = this.sim.get(targetId);
      const bs = f.body(body.index, s.t);
      const rel = s.r.sub(bs.r);
      const vr = s.v.sub(bs.v);
      const d = rel.length();
      const soi = targetId === 'moon' ? MOON_SOI : body.soi;
      if (!this.inTargetSoi && d < soi) {
        this.inTargetSoi = true;
        this.log(met, 'info', `Ingresso nella sfera d'influenza di ${body.name}`);
        if (!this.approachDone && !this.burn) {
          this.approachDone = true;
          this.approachCorrection(targetId);
          return true;
        }
      }
      if (this.inTargetSoi && !this.periapsisHandled) {
        const mu = this.sim.bodies.filter((x) => x.id === targetId || (x.parentId === targetId && targetId !== 'earth')).reduce((q, x) => q + x.gm, 0);
        if (!this.closest || d < this.closest.d) this.closest = { body: targetId, d, t: s.t };
        const o = stateToElements(rel, vr, mu);
        const n = Math.sqrt(mu / Math.abs(o.a) ** 3);
        const approaching = rel.dot(vr) < 0;
        // frenata centrata sul periasse
        if (this.cfg.arrivalMode === 'orbit' && approaching && !this.burn && !this.captureStarted) {
          const tp = o.isBound ? (2 * Math.PI - o.M) / n : -o.M / n;
          const rApo = this.captureApo(targetId).capture;
          const vp = Math.sqrt(mu * (2 / o.periapsis - (o.isBound ? 1 / o.a : 1 / o.a)));
          const vt = Math.sqrt((2 * mu * rApo) / (o.periapsis * (o.periapsis + rApo)));
          const eng = this.engineFor('payload')!;
          const tb = eng.thrust > 0 ? this.burnTime(Math.max(0, vp - vt), eng, s.m) : 0;
          if (tp <= tb / 2 && o.periapsis > body.radius) {
            this.captureStarted = true;
            this.captureBurn(targetId);
            return true;
          }
        }
        if (!approaching && this.closest.d < soi) {
          this.periapsisHandled = true;
          const alt = this.closest.d - body.radius;
          this.log(this.closest.t - this.cfg.launchTime, 'info', `Massimo avvicinamento a ${body.name}: ${(alt / 1e3).toFixed(0)} km di quota`);
          if (this.cfg.arrivalMode === 'flyby') this.complete(s.t, `Flyby di ${body.name} completato`);
        }
      }
    }
    return false;
  }

  /** Corpo di riferimento per la telemetria (sfera d'influenza più piccola che contiene la sonda). */
  dominant(): string {
    const f = this.field;
    const t = this.prop?.state.t ?? this.sim.time;
    const r = this.position;
    let best = 'sun';
    let bestSoi = Infinity;
    for (const b of this.sim.bodies) {
      if (b.gm <= 0 || b.kind === 'star') continue;
      const soi = b.id === 'moon' ? MOON_SOI : b.soi;
      if (soi >= bestSoi) continue;
      const p = f ? f.body(b.index, t).r : this.sim.position(b.id);
      if (r.distanceTo(p) < soi) {
        best = b.id;
        bestSoi = soi;
      }
    }
    return best;
  }

  // ───────────────────────── Telemetria ─────────────────────────

  telemetry(): MissionTelemetry {
    const met = this.met;
    const nextEvent = this.schedule[0] ? { name: this.schedule[0].name, in: this.schedule[0].t - this.sim.time } : undefined;
    if (this.phase === 'countdown' || !this.ascent) {
      return {
        met, phase: 'Conto alla rovescia', ref: 'Terra', altitude: 0, speed: 0, accelG: 1, mass: this.liftoffMass(), thrust: 0,
        stage: this.cfg.rocket.stages[0].name, apoapsis: 0, periapsis: 0, inclination: 0, eccentricity: 0, period: 0,
        distEarth: R_EQ, distSun: 0, lat: this.cfg.site.lat, lon: this.cfg.site.lon, dvRemaining: 0,
        upperProp: 0, payloadProp: this.payloadProp, nextEvent: { name: 'Decollo', in: -met },
      };
    }
    if (this.phase === 'ascent' || (this.phase === 'failed' && !this.prop)) {
      const a = this.ascent.telemetry();
      const phaseNames: Record<string, string> = {
        vertical: 'Salita verticale', pitchover: 'Manovra di beccheggio', gravityTurn: 'Gravity turn',
        guidance: 'Guida a circuito chiuso', orbit: 'In orbita', suborbital: 'Traiettoria suborbitale', crashed: 'Distrutto',
      };
      const tel: MissionTelemetry = {
        met, phase: phaseNames[this.ascent.phase] ?? this.ascent.phase, ref: 'Terra', altitude: a.altitude, speed: a.speed,
        verticalSpeed: a.verticalSpeed, accelG: a.accelG, q: a.q, mach: a.mach, mass: a.mass, throttle: a.throttle, thrust: a.thrust,
        stage: a.stageName, propFraction: a.stagePropFraction, apoapsis: a.apoapsis, periapsis: a.periapsis,
        inclination: a.inclination, eccentricity: this.ascent.orbit().e, period: 0,
        distEarth: a.altitude + R_EQ, distSun: this.position.distanceTo(this.sim.position('sun')),
        lat: a.lat, lon: a.lon, downrange: a.downrange, dvRemaining: a.dvRemaining, upperProp: 0, payloadProp: this.payloadProp,
        burning: this.ascent.engine === 'burning' ? a.stageName : undefined,
      };
      this.lastTel = tel;
      return tel;
    }
    const s = this.prop!.state;
    const dom = this.dominant();
    const body = this.sim.get(dom);
    const f = this.field!;
    const bs = f.body(body.index, s.t);
    const rel = s.r.sub(bs.r);
    const vrel = s.v.sub(bs.v);
    const mu = dom === 'sun' ? body.gm : this.sim.bodies.filter((x) => x.id === dom || (x.parentId === dom && dom !== 'earth')).reduce((q, x) => q + x.gm, 0);
    let o = stateToElements(rel, vrel, mu);
    if (dom === 'earth') {
      const M = temeToEclipticMatrix(s.t);
      o = stateToElements(eclipticToEci(rel, M), eclipticToEci(vrel, M), mu);
    }
    const R = dom === 'sun' ? 0 : body.radius;
    const e = f.earth(s.t);
    const upperProp = this.upper?.prop ?? 0;
    const ve = (isp: number) => isp * G0;
    let dvRem = 0;
    let m = s.m;
    if (this.upper && upperProp > 0) {
      dvRem += ve(this.upper.isp) * Math.log(m / (m - upperProp));
      m -= upperProp + this.upperDry;
    }
    if (this.payloadProp > 0 && m > this.payloadProp) dvRem += ve(this.cfg.payload.isp) * Math.log(m / (m - this.payloadProp));
    const tel: MissionTelemetry = {
      met,
      phase: this.phase === 'complete' ? 'Missione completata' : this.phase === 'failed' ? 'Missione fallita' : this.burn ? 'Combustione' : 'Volo balistico',
      ref: body.name,
      altitude: rel.length() - R,
      speed: vrel.length(),
      verticalSpeed: rel.normalize().dot(vrel),
      accelG: this.prop!.thrustAccel / G0,
      mass: s.m,
      thrust: this.prop!.thrust?.thrust ?? 0,
      stage: this.upper ? this.upper.name : this.cfg.payload.name,
      apoapsis: o.isBound ? o.apoapsis - R : Infinity,
      periapsis: o.periapsis - R,
      inclination: o.i / DEG_RAD,
      eccentricity: o.e,
      period: o.period,
      distEarth: s.r.distanceTo(e.r),
      distSun: s.r.distanceTo(f.body(this.sim.get('sun').index, s.t).r),
      dvRemaining: dvRem,
      upperProp,
      payloadProp: this.payloadProp,
      nextEvent,
      burning: this.burn?.name,
    };
    this.lastTel = tel;
    return tel;
  }

  liftoffMass(): number {
    const r = this.cfg.rocket;
    return this.cfg.payload.mass + r.fairingMass + r.stages.reduce((s, st) => s + st.count * (st.dryMass + st.propMass), 0);
  }

  get lastTelemetry(): MissionTelemetry | null {
    return this.lastTel;
  }
}
