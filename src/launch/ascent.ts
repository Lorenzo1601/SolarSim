/**
 * Simulazione fisica della salita di un lanciatore reale, nel frame inerziale geocentrico ECI.
 *
 * Forze: gravità (μ/r² + J2), spinta (variabile con la pressione esterna fra livello del mare e vuoto),
 * resistenza aerodinamica (atmosfera US 1976, Cd funzione del Mach, atmosfera solidale alla Terra).
 * Massa: consumo di propellente per stadio (portata = spinta_vuoto / (Isp_vuoto·g0)), separazioni.
 *
 * Guida:
 *  1. salita verticale fino a `pitchStartSpeed`;
 *  2. "pitch kick" di qualche grado verso l'azimut di lancio;
 *  3. gravity turn: spinta allineata alla velocità relativa all'aria (angolo d'attacco nullo);
 *  4. guida a circuito chiuso fuori dall'atmosfera: controllo di quota/velocità radiale (legge a
 *     "tempo mancante", tipo E-guidance) e del piano orbitale (azzera la velocità fuori piano);
 *     spegnimento quando l'energia orbitale raggiunge quella dell'orbita circolare obiettivo.
 * Limiti: accelerazione massima e "throttle bucket" sul Max-Q per gli stadi regolabili.
 * Integrazione: Runge–Kutta 4 a passo fisso (0,1 s tipico).
 */
import { Vec3 } from '../physics/vec3.ts';
import { atmosphere, dragCoefficient, P0 } from './atmosphere.ts';
import {
  G0, MU_EARTH, OMEGA_EARTH, R_EQ, altitudeOf, ecefToGeodetic, geodeticToEcef, groundVelocity, j2Accel, rotZ,
} from './earthModel.ts';
import type { LaunchSite, RocketDef, StageDef } from './rockets.ts';

export interface AscentParams {
  rocket: RocketDef;
  payloadMass: number;
  site: LaunchSite;
  /** Quota di inserimento = perigeo dell'orbita obiettivo [m]. */
  targetAltitude: number;
  /** Apogeo dell'orbita di inserimento [m] (default = perigeo: orbita circolare). */
  targetApoapsis?: number;
  /** Inclinazione richiesta [rad]. */
  inclination: number;
  /** Azimut verso sud (nodo discendente), es. orbite polari/SSO da Vandenberg. */
  southward: boolean;
  maxAccelG: number;
  /** Soglia di pressione dinamica per ridurre la spinta [Pa]. */
  maxQ: number;
  pitchKick: number;
  pitchStartSpeed: number;
  /** Conserva il 10% di propellente negli stadi recuperabili (atterraggio). */
  recovery: boolean;
  /** Angolo di rotazione terrestre al decollo (GMST + longitudine gestita qui) [rad]. */
  theta0: number;
}

export type AscentPhase = 'vertical' | 'pitchover' | 'gravityTurn' | 'guidance' | 'orbit' | 'suborbital' | 'crashed';

export interface FlightEvent {
  /** Secondi dal decollo. */
  t: number;
  kind: 'liftoff' | 'maxq' | 'booster' | 'meco' | 'separation' | 'ignition' | 'fairing' | 'karman' | 'seco' | 'orbit' | 'failure' | 'info' | 'burn' | 'cutoff';
  text: string;
}

interface StageRt {
  def: StageDef;
  index: number;
  prop: number;
  reserve: number;
  attached: boolean;
  ignited: boolean;
}

export const DEG_RAD = Math.PI / 180;

/** Azimut di lancio inerziale e "ruotante" per raggiungere l'inclinazione i da latitudine lat. */
export function launchAzimuth(latRad: number, incl: number, vOrbit: number, southward: boolean): {
  inertial: number; rotating: number; reachable: boolean; actualInclination: number;
} {
  const ratio = Math.cos(incl) / Math.cos(latRad);
  const reachable = Math.abs(ratio) <= 1;
  let bi = Math.asin(Math.max(-1, Math.min(1, ratio)));
  if (southward) bi = Math.PI - bi;
  const vEq = OMEGA_EARTH * R_EQ * Math.cos(latRad);
  const rot = Math.atan2(vOrbit * Math.sin(bi) - vEq, vOrbit * Math.cos(bi));
  const actualInclination = reachable ? incl : Math.acos(Math.max(-1, Math.min(1, Math.cos(latRad) * Math.sin(bi))));
  return { inertial: bi, rotating: rot, reachable, actualInclination };
}

/** Delta-v ideale (Tsiolkovsky) di un razzo con carico, stadio per stadio. */
export function idealDeltaV(rocket: RocketDef, payload: number): { total: number; stages: number[]; liftoffMass: number; twr: number } {
  const stages = rocket.stages;
  let m = payload + rocket.fairingMass + stages.reduce((s, st) => s + st.count * (st.dryMass + st.propMass), 0);
  const liftoffMass = m;
  // spinta al decollo: primo gruppo (paralleli + primo centrale)
  let thrust0 = 0;
  for (const st of stages) {
    thrust0 += st.count * st.thrustSL;
    if (!st.parallel) break;
  }
  const out: number[] = [];
  let fairingOn = rocket.fairingMass > 0;
  for (const st of stages) {
    const prop = st.count * st.propMass;
    const dv = st.ispVac * G0 * Math.log(m / (m - prop));
    out.push(dv);
    m -= prop + st.count * st.dryMass;
    if (fairingOn && !st.parallel) {
      m -= rocket.fairingMass; // ogiva espulsa dopo il primo stadio (approssimazione)
      fairingOn = false;
    }
  }
  return { total: out.reduce((a, b) => a + b, 0), stages: out, liftoffMass, twr: thrust0 / (liftoffMass * G0) };
}

export interface AscentTelemetry {
  t: number;
  altitude: number;
  speed: number;
  surfaceSpeed: number;
  verticalSpeed: number;
  downrange: number;
  accelG: number;
  q: number;
  mach: number;
  mass: number;
  thrust: number;
  throttle: number;
  pitch: number;
  stageName: string;
  stagePropFraction: number;
  lat: number;
  lon: number;
  apoapsis: number;
  periapsis: number;
  inclination: number;
  dvRemaining: number;
}

export class AscentVehicle {
  readonly p: AscentParams;
  /** Secondi dal decollo. */
  t = 0;
  r: Vec3;
  v: Vec3;
  u: Vec3;
  phase: AscentPhase = 'vertical';
  engine: 'burning' | 'staging' | 'igniting' | 'off' = 'burning';
  private timer = 0;
  stages: StageRt[];
  fairing: boolean;
  throttle = 1;
  readonly planeNormal: Vec3;
  readonly azimuthRot: number;
  readonly azimuthInertial: number;
  readonly reachable: boolean;
  readonly actualInclination: number;
  readonly siteEcef: Vec3;
  events: FlightEvent[] = [];
  // diagnostica corrente
  q = 0;
  mach = 0;
  thrust = 0;
  accelSensed = 0;
  maxQ = 0;
  maxQTime = 0;
  private maxQLogged = false;
  private karman = false;
  private pitchStart = 0;
  private readonly targetR: number;
  /** Semiasse maggiore e velocità orizzontale all'inserimento (perigeo). */
  private readonly targetA: number;
  private readonly targetV: number;

  constructor(p: AscentParams) {
    this.p = p;
    this.siteEcef = geodeticToEcef(p.site.lat, p.site.lon, p.site.alt);
    this.r = rotZ(this.siteEcef, p.theta0);
    this.v = groundVelocity(this.r);
    this.u = this.r.normalize();
    this.targetR = R_EQ + p.targetAltitude;
    const rApo = R_EQ + Math.max(p.targetApoapsis ?? p.targetAltitude, p.targetAltitude);
    this.targetA = (this.targetR + rApo) / 2;
    this.targetV = Math.sqrt(MU_EARTH * (2 / this.targetR - 1 / this.targetA));
    this.stages = p.rocket.stages.map((def, index) => {
      const prop = def.count * def.propMass;
      return { def, index, prop, reserve: p.recovery && def.recoverable ? prop * 0.1 : 0, attached: true, ignited: false };
    });
    this.fairing = p.rocket.fairingMass > 0;
    const lat = (p.site.lat * Math.PI) / 180;
    const az = launchAzimuth(lat, p.inclination, this.targetV, p.southward);
    this.azimuthRot = az.rotating;
    this.azimuthInertial = az.inertial;
    this.reachable = az.reachable;
    this.actualInclination = az.actualInclination;
    const up = this.r.normalize();
    const east = new Vec3(0, 0, 1).cross(up).normalize();
    const north = up.cross(east);
    const d = east.scale(Math.sin(az.inertial)).add(north.scale(Math.cos(az.inertial)));
    this.planeNormal = up.cross(d).normalize();
    for (const s of this.activeStages()) s.ignited = true;
    this.log('liftoff', 'Decollo!');
    if (!az.reachable) {
      this.log('info', `Inclinazione ${(p.inclination / DEG_RAD).toFixed(1)}° non raggiungibile direttamente da latitudine ${p.site.lat.toFixed(1)}°: si usa ${(az.actualInclination / DEG_RAD).toFixed(1)}°`);
    }
  }

  private log(kind: FlightEvent['kind'], text: string): void {
    this.events.push({ t: this.t, kind, text });
  }

  /** Indice dello stadio "centrale" attuale (primo non parallelo ancora agganciato). */
  private coreIndex(): number {
    return this.stages.findIndex((s) => s.attached && !s.def.parallel);
  }

  /** Stadi che stanno spingendo (booster paralleli agganciati + stadio centrale). */
  activeStages(): StageRt[] {
    if (this.engine !== 'burning') return [];
    const k = this.coreIndex();
    if (k < 0) return [];
    const out: StageRt[] = [];
    for (let i = k - 1; i >= 0 && this.stages[i].def.parallel; i--) {
      const s = this.stages[i];
      if (s.attached && s.prop > s.reserve) out.push(s);
    }
    const core = this.stages[k];
    if (core.prop > core.reserve) out.push(core);
    return out;
  }

  get mass(): number {
    let m = this.p.payloadMass + (this.fairing ? this.p.rocket.fairingMass : 0);
    for (const s of this.stages) if (s.attached) m += s.def.count * s.def.dryMass + s.prop;
    return m;
  }

  get altitude(): number {
    return altitudeOf(this.r);
  }

  private boostersAttached(k: number): boolean {
    for (let i = k - 1; i >= 0 && this.stages[i].def.parallel; i--) if (this.stages[i].attached) return true;
    return false;
  }

  /** Spinta [N] e portata [kg/s] al throttle indicato, alla pressione p. */
  private propulsion(p: number, throttle: number): { F: number; mdot: number; flows: [StageRt, number][] } {
    const active = this.activeStages();
    const k = this.coreIndex();
    let F = 0;
    let mdot = 0;
    const flows: [StageRt, number][] = [];
    const pr = Math.min(1, p / P0);
    for (const s of active) {
      const d = s.def;
      let thr = d.minThrottle >= 1 ? 1 : Math.max(d.minThrottle, throttle);
      if (s.index === k && d.throttleWithBoosters && this.boostersAttached(k)) thr = Math.min(thr, d.throttleWithBoosters);
      const unitF = d.thrustVac - (d.thrustVac - d.thrustSL) * pr;
      const unitMdot = d.thrustVac / (d.ispVac * G0);
      F += d.count * unitF * thr;
      const f = d.count * unitMdot * thr;
      mdot += f;
      flows.push([s, f]);
    }
    return { F, mdot, flows };
  }

  private accel(r: Vec3, v: Vec3, m: number, F: number, u: Vec3): { a: Vec3; drag: number; q: number; mach: number } {
    const rr = r.length();
    let a = r.scale(-MU_EARTH / (rr * rr * rr)).add(j2Accel(r));
    const h = altitudeOf(r);
    let drag = 0;
    let q = 0;
    let mach = 0;
    if (h < 1_000_000) {
      const atm = atmosphere(h);
      const vRel = v.sub(groundVelocity(r));
      const sp = vRel.length();
      q = 0.5 * atm.rho * sp * sp;
      mach = atm.a > 0 ? sp / atm.a : 0;
      if (sp > 0 && q > 0) {
        const A = Math.PI * (this.p.rocket.diameter / 2) ** 2;
        drag = q * dragCoefficient(mach, this.p.rocket.cd) * A;
        a = a.add(vRel.scale(-drag / (m * sp)));
      }
    }
    if (F > 0) a = a.add(u.scale(F / m));
    return { a, drag, q, mach };
  }

  /** Direzione di spinta comandata dalla guida. */
  private steering(thrustAccel: number): Vec3 {
    const up = this.r.normalize();
    const vRel = this.v.sub(groundVelocity(this.r));
    const east = new Vec3(0, 0, 1).cross(up).normalize();
    const north = up.cross(east);
    const azDir = east.scale(Math.sin(this.azimuthRot)).add(north.scale(Math.cos(this.azimuthRot)));

    if (this.phase === 'vertical') return up;
    if (this.phase === 'pitchover') {
      const k = Math.min(1, (this.t - this.pitchStart) / 8) * this.p.pitchKick;
      return up.scale(Math.cos(k)).add(azDir.scale(Math.sin(k)));
    }
    if (this.phase === 'gravityTurn') {
      // Vento relativo nel piano verticale di lancio (evita derive laterali a bassa velocità)
      return vRel.lengthSq() > 1 ? vRel.normalize() : up;
    }
    // Guida a circuito chiuso
    const n = this.planeNormal;
    const s = n.cross(up).normalize();
    const rr = this.r.length();
    const vr = this.v.dot(up);
    const vS = this.v.dot(s);
    const vN = this.v.dot(n);
    const vt = this.targetV;
    const a = Math.max(thrustAccel, 0.05);
    const dvGo = Math.hypot(Math.max(vt - vS, 0), vr, vN);
    const tgo = Math.max(this.timeToGo(dvGo), 8);
    const aR = (6 * (this.targetR - rr)) / (tgo * tgo) - (4 * vr) / tgo;
    const gEff = MU_EARTH / (rr * rr) - (vS * vS + vN * vN) / rr;
    const sr = Math.max(-0.6, Math.min(0.97, (aR + gEff) / a));
    // piano orbitale: annulla sia la distanza dal piano sia la velocità fuori piano
    const zN = this.r.dot(n);
    const aN = (-6 * zN) / (tgo * tgo) - (4 * vN) / tgo;
    const sn = Math.max(-0.35, Math.min(0.35, aN / a));
    const sh = Math.sqrt(Math.max(0, 1 - sr * sr - sn * sn));
    return up.scale(sr).add(n.scale(sn)).add(s.scale(sh)).normalize();
  }

  /** Energia orbitale specifica raggiunta (semiasse maggiore dell'orbita obiettivo). */
  private energyReached(): boolean {
    const e = this.v.lengthSq() / 2 - MU_EARTH / this.r.length();
    return e >= -MU_EARTH / (2 * this.targetA);
  }

  /** Tempo di combustione per ottenere dv, attraversando gli stadi rimanenti (equazione del razzo). */
  private timeToGo(dv: number): number {
    let m = this.mass;
    let t = 0;
    let left = dv;
    const k = this.coreIndex();
    if (k < 0) return 1e6;
    for (let i = k; i < this.stages.length && left > 0; i++) {
      const s = this.stages[i];
      if (s.def.parallel) continue;
      const usable = s.prop - s.reserve;
      const ve = s.def.ispVac * G0;
      const mdot = (s.def.count * s.def.thrustVac) / ve;
      const dvStage = ve * Math.log(m / (m - usable));
      if (dvStage >= left) {
        t += (m / mdot) * (1 - Math.exp(-left / ve));
        left = 0;
      } else {
        t += usable / mdot + 5;
        left -= dvStage;
        m -= usable + s.def.count * s.def.dryMass + s.reserve;
      }
    }
    return left > 0 ? t + left / 5 : t;
  }

  step(dt: number): void {
    if (this.phase === 'crashed') return;
    const h = this.altitude;
    const atm = atmosphere(h);

    // ── Sequenza degli stadi ──
    if (this.engine === 'staging') {
      this.timer -= dt;
      if (this.timer <= 0) {
        const k = this.coreIndex();
        if (k >= 0) {
          this.stages[k].attached = false;
          this.log('separation', `Separazione: ${this.stages[k].def.name}`);
        }
        const next = this.coreIndex();
        if (next >= 0) {
          this.engine = 'igniting';
          this.timer = 2;
        } else {
          this.engine = 'off';
        }
      }
    } else if (this.engine === 'igniting') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.engine = 'burning';
        const k = this.coreIndex();
        this.stages[k].ignited = true;
        this.log('ignition', `Accensione: ${this.stages[k].def.name}`);
        if (this.phase !== 'guidance' && this.phase !== 'orbit') this.phase = 'guidance';
      }
    }

    // ── Controllo della spinta ──
    const full = this.propulsion(atm.p, 1);
    const m = this.mass;
    let throttle = 1;
    if (full.F > 0) {
      const maxA = this.p.maxAccelG * G0;
      if (full.F / m > maxA) throttle = Math.min(throttle, (maxA * m) / full.F);
      if (this.q > this.p.maxQ * 0.85) throttle = Math.min(throttle, 1 - (this.q - this.p.maxQ * 0.85) / (this.p.maxQ * 0.5));
    }
    this.throttle = Math.max(0, Math.min(1, throttle));
    const prop = this.propulsion(atm.p, this.throttle);

    // ── Guida (con limite di velocità angolare) ──
    if (prop.F > 0) {
      const cmd = this.steering(prop.F / m);
      const maxRate = (h < 60000 ? 3 : 8) * DEG_RAD * dt;
      const ang = this.u.angleTo(cmd);
      if (ang <= maxRate || this.phase === 'vertical') this.u = cmd;
      else {
        const k = maxRate / ang;
        this.u = this.u.scale(1 - k).add(cmd.scale(k)).normalize();
      }
    }

    // ── Integrazione RK4 ──
    const F = prop.F;
    const u = this.u;
    const r0 = this.r;
    const v0 = this.v;
    const m0 = m;
    const md = prop.mdot;
    const f = (r: Vec3, v: Vec3, mm: number) => this.accel(r, v, mm, F, u).a;
    const k1v = f(r0, v0, m0);
    const k1r = v0;
    const k2r = v0.add(k1v.scale(dt / 2));
    const k2v = f(r0.add(k1r.scale(dt / 2)), k2r, m0 - (md * dt) / 2);
    const k3r = v0.add(k2v.scale(dt / 2));
    const k3v = f(r0.add(k2r.scale(dt / 2)), k3r, m0 - (md * dt) / 2);
    const k4r = v0.add(k3v.scale(dt));
    const k4v = f(r0.add(k3r.scale(dt)), k4r, m0 - md * dt);
    this.r = r0.add(k1r.add(k2r.scale(2)).add(k3r.scale(2)).add(k4r).scale(dt / 6));
    this.v = v0.add(k1v.add(k2v.scale(2)).add(k3v.scale(2)).add(k4v).scale(dt / 6));
    for (const [s, flow] of prop.flows) s.prop = Math.max(s.reserve, s.prop - flow * dt);
    this.t += dt;

    // ── Diagnostica ──
    const diag = this.accel(this.r, this.v, this.mass, F, u);
    this.q = diag.q;
    this.mach = diag.mach;
    this.thrust = F;
    this.accelSensed = (F + diag.drag) / this.mass / G0;
    if (this.q > this.maxQ) {
      this.maxQ = this.q;
      this.maxQTime = this.t;
    } else if (!this.maxQLogged && this.maxQ > 1000 && this.q < this.maxQ * 0.9) {
      this.maxQLogged = true;
      this.events.push({ t: this.maxQTime, kind: 'maxq', text: `Max-Q: ${(this.maxQ / 1000).toFixed(1)} kPa` });
    }
    const hNow = this.altitude;
    if (!this.karman && hNow > 100000) {
      this.karman = true;
      this.log('karman', 'Linea di Kármán (100 km): nello spazio');
    }
    if (this.fairing && hNow > 110000 && this.q < 50) {
      this.fairing = false;
      this.log('fairing', 'Separazione dell\'ogiva');
    }

    // ── Transizioni di fase ──
    const vRel = this.v.sub(groundVelocity(this.r));
    const up = this.r.normalize();
    if (this.phase === 'vertical' && vRel.length() > this.p.pitchStartSpeed) {
      this.phase = 'pitchover';
      this.pitchStart = this.t;
      this.log('info', `Inizio manovra di beccheggio (${(this.p.pitchKick / DEG_RAD).toFixed(1)}°)`);
    } else if (this.phase === 'pitchover' && this.t - this.pitchStart > 8) {
      const aoa = vRel.angleTo(up);
      if (aoa >= this.p.pitchKick * 0.9 || this.t - this.pitchStart > 25) {
        this.phase = 'gravityTurn';
        this.log('info', 'Gravity turn');
      }
    } else if (this.phase === 'gravityTurn' && hNow > 45000 && this.q < 3000) {
      this.phase = 'guidance';
      this.log('info', 'Guida a circuito chiuso attiva');
    }

    // Booster esauriti → separazione
    const k = this.coreIndex();
    for (let i = k - 1; i >= 0 && this.stages[i]?.def.parallel; i--) {
      const s = this.stages[i];
      if (s.attached && s.prop <= s.reserve + 1e-6) {
        s.attached = false;
        this.log('booster', `Separazione booster: ${s.def.name}`);
      }
    }

    // Spegnimento a energia raggiunta (non possibile per i motori a propellente solido)
    const coreSolid = k >= 0 && !!this.stages[k].def.solid;
    if (this.engine === 'burning' && this.phase === 'guidance' && !coreSolid && this.energyReached()) {
      this.engine = 'off';
      const el = this.orbit();
      const ok = el.periapsis - R_EQ > 100000;
      this.phase = ok ? 'orbit' : 'suborbital';
      this.log('seco', `Spegnimento motori (SECO): ${this.stages[this.coreIndex()]?.def.name ?? ''}`);
      this.log(ok ? 'orbit' : 'failure', ok
        ? `Orbita raggiunta: ${((el.periapsis - R_EQ) / 1000).toFixed(0)} × ${((el.apoapsis - R_EQ) / 1000).toFixed(0)} km, i = ${(el.inclination / DEG_RAD).toFixed(2)}°`
        : 'Energia raggiunta ma perigeo troppo basso: traiettoria suborbitale');
      return;
    }

    // Stadio centrale esaurito → MECO / staging
    if (this.engine === 'burning' && k >= 0) {
      const core = this.stages[k];
      if (core.prop <= core.reserve + 1e-6) {
        const hasNext = this.stages.slice(k + 1).some((s) => !s.def.parallel);
        this.log(hasNext ? 'meco' : 'cutoff', `${hasNext ? 'Spegnimento' : 'Propellente esaurito'}: ${core.def.name}`);
        this.engine = 'staging';
        this.timer = 3;
        if (!hasNext) {
          this.engine = 'off';
          const el = this.orbit();
          const ok = el.periapsis - R_EQ > 100000;
          this.phase = ok ? 'orbit' : 'suborbital';
          this.log(ok ? 'orbit' : 'failure', ok
            ? `Orbita raggiunta a propellente esaurito: ${((el.periapsis - R_EQ) / 1000).toFixed(0)} × ${((el.apoapsis - R_EQ) / 1000).toFixed(0)} km`
            : 'Propellente esaurito prima dell\'orbita: traiettoria suborbitale');
        }
      }
    }

    if (hNow < -100 && this.t > 5) {
      this.phase = 'crashed';
      this.engine = 'off';
      this.log('failure', 'Impatto al suolo / in mare');
    }
  }

  /** Orbita osculante geocentrica (raggi di apogeo e perigeo, inclinazione). */
  orbit(): { apoapsis: number; periapsis: number; inclination: number; a: number; e: number } {
    const r = this.r;
    const v = this.v;
    const rr = r.length();
    const h = r.cross(v);
    const e = v.lengthSq() / 2 - MU_EARTH / rr;
    const a = -MU_EARTH / (2 * e);
    const ecc = Math.sqrt(Math.max(0, 1 - h.lengthSq() / (MU_EARTH * a)));
    const hl = h.length();
    return {
      a,
      e: ecc,
      apoapsis: e < 0 ? a * (1 + ecc) : Infinity,
      periapsis: (hl * hl) / MU_EARTH / (1 + ecc),
      inclination: Math.acos(Math.max(-1, Math.min(1, h.z / hl))),
    };
  }

  /** Delta-v residuo (Tsiolkovsky) degli stadi ancora disponibili. */
  dvRemaining(): number {
    let m = this.mass;
    let dv = 0;
    const k = this.coreIndex();
    if (k < 0) return 0;
    for (let i = 0; i < this.stages.length; i++) {
      const s = this.stages[i];
      if (!s.attached || (i < k && !s.def.parallel)) continue;
      const usable = s.prop - s.reserve;
      if (usable <= 0) {
        if (i >= k) m -= s.def.count * s.def.dryMass + s.prop;
        continue;
      }
      dv += s.def.ispVac * G0 * Math.log(m / (m - usable));
      m -= usable + s.def.count * s.def.dryMass + s.reserve;
    }
    return dv;
  }

  telemetry(): AscentTelemetry {
    const up = this.r.normalize();
    const vRel = this.v.sub(groundVelocity(this.r));
    const theta = this.p.theta0 + OMEGA_EARTH * this.t;
    const ecef = rotZ(this.r, -theta);
    const geo = ecefToGeodetic(ecef);
    const siteDir = this.siteEcef.normalize();
    const downrange = Math.acos(Math.max(-1, Math.min(1, ecef.normalize().dot(siteDir)))) * R_EQ;
    const el = this.orbit();
    const k = this.coreIndex();
    const core = k >= 0 ? this.stages[k] : null;
    return {
      t: this.t,
      altitude: this.altitude,
      speed: this.v.length(),
      surfaceSpeed: vRel.length(),
      verticalSpeed: this.v.dot(up),
      downrange,
      accelG: this.accelSensed,
      q: this.q,
      mach: this.mach,
      mass: this.mass,
      thrust: this.thrust,
      throttle: this.engine === 'burning' ? this.throttle : 0,
      pitch: 90 - (this.u.angleTo(up) * 180) / Math.PI,
      stageName: core ? core.def.name : '—',
      stagePropFraction: core ? core.prop / (core.def.count * core.def.propMass) : 0,
      lat: geo.lat,
      lon: geo.lon,
      apoapsis: el.apoapsis - R_EQ,
      periapsis: el.periapsis - R_EQ,
      inclination: (el.inclination * 180) / Math.PI,
      dvRemaining: this.dvRemaining(),
    };
  }

  /**
   * Stadio superiore per le accensioni successive in orbita: lo stadio centrale se è a liquido
   * e riaccendibile ed è l'ultimo, altrimenti il primo stadio a liquido successivo (gli stadi
   * esauriti o a solido vengono sganciati).
   */
  upperStage(): { name: string; prop: number; dry: number; thrust: number; isp: number } | null {
    const k = this.coreIndex();
    if (k < 0) return null;
    const rest = this.stages.slice(k).filter((s) => s.attached && !s.def.parallel);
    const core = rest[0];
    const pick = rest.length === 1 && !core.def.solid ? core : rest.slice(1).find((s) => !s.def.solid) ?? (core.def.solid ? null : core);
    if (!pick) return null;
    return {
      name: pick.def.name,
      prop: Math.max(0, pick.prop - pick.reserve),
      dry: pick.def.count * pick.def.dryMass + pick.reserve,
      thrust: pick.def.count * pick.def.thrustVac,
      isp: pick.def.ispVac,
    };
  }
}

export interface AscentResult {
  success: boolean;
  vehicle: AscentVehicle;
  /** Punteggio per l'ottimizzazione [m/s]: Δv residuo se in orbita, deficit (negativo) se no. */
  score: number;
}

/** Simula l'intera salita (fino all'orbita o al fallimento). */
export function runAscent(p: AscentParams, dt = 0.2, maxTime = 3000): AscentResult {
  const v = new AscentVehicle(p);
  while (v.t < maxTime && (v.phase !== 'orbit' && v.phase !== 'suborbital' && v.phase !== 'crashed')) v.step(dt);
  const success = v.phase === 'orbit';
  let score: number;
  if (success) score = v.dvRemaining();
  else {
    const rT = R_EQ + p.targetAltitude;
    const e = v.v.lengthSq() / 2 - MU_EARTH / v.r.length();
    const eT = -MU_EARTH / (2 * rT);
    score = -Math.abs(eT - e) / Math.sqrt(MU_EARTH / rT) - (v.phase === 'crashed' ? 5000 : 0);
  }
  return { success, vehicle: v, score };
}

/** Cerca l'angolo di "pitch kick" che massimizza il propellente residuo in orbita. */
export function optimizePitchKick(p: Omit<AscentParams, 'pitchKick'>, dt = 0.25): { pitchKick: number; result: AscentResult } {
  const evalKick = (k: number) => runAscent({ ...p, pitchKick: k }, dt);
  let best = { k: 3 * DEG_RAD, res: evalKick(3 * DEG_RAD) };
  for (const deg of [0.8, 1.5, 2, 4, 5, 6, 8, 10, 13]) {
    const res = evalKick(deg * DEG_RAD);
    if (res.score > best.res.score) best = { k: deg * DEG_RAD, res };
  }
  // raffinamento a sezione aurea attorno al migliore
  let lo = Math.max(0.2 * DEG_RAD, best.k - 1.5 * DEG_RAD);
  let hi = best.k + 1.5 * DEG_RAD;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = evalKick(x1);
  let f2 = evalKick(x2);
  for (let i = 0; i < 8; i++) {
    if (f1.score > f2.score) {
      hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = evalKick(x1);
    } else {
      lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = evalKick(x2);
    }
  }
  for (const [k, res] of [[x1, f1], [x2, f2]] as const) if (res.score > best.res.score) best = { k, res };
  return { pitchKick: best.k, result: best.res };
}
