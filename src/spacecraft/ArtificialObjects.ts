/**
 * ArtificialObjects — stato e telemetria degli oggetti artificiali "in evidenza"
 * (ISS, Hubble, JWST, Voyager, …) e di quelli promossi dai cataloghi CelesTrak con un clic.
 *
 * Non tocca il motore fisico: legge le posizioni dei corpi naturali (centri di riferimento)
 * e calcola per ogni oggetto posizione e velocità RELATIVE al proprio centro, nel frame del
 * motore (eclittica J2000, metri):
 *   - TLE      → SGP4 (satellite.js) + conversione TEME → eclittica J2000
 *   - Horizons → tabelle JPL interpolate (Hermite); fuori tabella estrapolazione kepleriana
 *                e nuova richiesta per l'intervallo corrente.
 * Tutto è calcolato al TEMPO DI SIMULAZIONE: in modalità LIVE coincide con l'ora reale.
 */
import { eciToGeodetic, gstime, json2satrec, propagate, type SatRec } from 'satellite.js';
import { DAY, dateFromSimTime, simTimeFromDate } from '../physics/constants.ts';
import { propagateKepler, stateToElements, type OrbitInfo } from '../physics/kepler.ts';
import type { Simulation } from '../physics/simulation.ts';
import { Vec3 } from '../physics/vec3.ts';
import { fetchCelestrak, fetchDsnXml, fetchHorizonsVectors, fetchSbdb, type OMM, type SbdbPhys } from './api.ts';
import { CATEGORY_INFO, FEATURED, type ArtificialDef, type ArtificialSource } from './catalog.ts';
import { linksForNaif, parseDsnXml, type DsnLink, type DsnSnapshot } from './dsn.ts';
import { TabulatedEphemeris, parseCoverageLimit, parseHorizonsVectors, simTimeToJd, jdToSimTime } from './horizons.ts';
import { applyMat3, temeToEclipticMatrix } from './teme.ts';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type StateMode = 'sgp4' | 'tabulated' | 'kepler' | 'archive' | 'none';

type HorizonsSource = Extract<ArtificialSource, { type: 'horizons' }>;

/** Oltre questa distanza dall'epoca del TLE si passa all'archivio JPL (se esiste). */
const ARCHIVE_AGE = 20 * DAY;

export interface ArtificialObject {
  def: ArtificialDef;
  color: string;
  visible: boolean;
  /** Promosso da un catalogo CelesTrak (non nel catalogo in evidenza). */
  transient: boolean;
  status: LoadStatus;
  message: string;
  /** Stato valido al tempo corrente. */
  valid: boolean;
  mode: StateMode;
  /** Posizione [m] e velocità [m/s] relative al centro, eclittica J2000. */
  rel: Vec3;
  vel: Vec3;
  // TLE
  satrec?: SatRec;
  omm?: OMM;
  tleEpoch?: number;
  geodetic?: { lat: number; lon: number; alt: number };
  // Horizons
  table?: TabulatedEphemeris;
  /** Limiti di copertura delle effemeridi JPL scoperti [s da J2000]. */
  coverage: { start?: number; end?: number };
  history?: Vec3[];
  historyStatus: LoadStatus;
  lastRequest: number;
  pending: boolean;
  /** Satelliti: archivio storico JPL Horizons (per date lontane dall'epoca del TLE). */
  archive?: HorizonsSource;
  archiveUnavailable?: boolean;
  /** Oggetto eliocentrico dentro la sfera d'influenza di un pianeta: tabella a passo fine (flyby). */
  fine?: boolean;
  /** Corpi minori: dati fisici dal JPL Small-Body Database. */
  phys?: SbdbPhys;
  physStatus?: LoadStatus;
}

export interface ArtificialTelemetry {
  obj: ArtificialObject;
  centerName: string;
  /** Distanza dal centro [m] e quota sopra la superficie [m] (non per il Sole). */
  distance: number;
  altitude?: number;
  /** Velocità rispetto al centro [m/s]. */
  speed: number;
  /** Velocità eliocentrica [m/s]. */
  speedSun: number;
  distEarth: number;
  distSun: number;
  /** Tempo luce dalla Terra [s]. */
  lightTime: number;
  orbit?: OrbitInfo;
  /** Inclinazione rispetto all'equatore terrestre [°] (solo TLE). */
  inclinationEq?: number;
  /** Periodo medio dal TLE [s]. */
  periodTle?: number;
  dsn: DsnLink[];
  dsnTime?: number;
  /** Età del dato: per i TLE, tempo dall'epoca degli elementi [s]. */
  dataAge?: number;
  source: string;
  phys?: SbdbPhys;
}

const C_LIGHT = 299_792_458;
const STORAGE_KEY = 'solarsim.artificial.v1';
/** Intervallo minimo fra due richieste Horizons per lo stesso oggetto [ms]. */
const HORIZONS_THROTTLE = 4000;

function parseStep(step: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([dhm])$/.exec(step.trim());
  if (!m) return DAY;
  const k = m[2] === 'd' ? DAY : m[2] === 'h' ? 3600 : 60;
  return Number(m[1]) * k;
}

function loadStored(): { visible?: string[]; hidden?: string[]; groups?: string[] } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export class ArtificialObjects {
  readonly objects = new Map<string, ArtificialObject>();
  dsn: DsnSnapshot | null = null;
  dsnError = '';
  /** Chiamata quando cambia lo stato di caricamento o di visibilità (per aggiornare la UI). */
  onChange: () => void = () => {};

  private readonly sim: Simulation;
  private dsnTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sim: Simulation, defs: readonly ArtificialDef[] = FEATURED) {
    this.sim = sim;
    const stored = loadStored();
    for (const def of defs) {
      const visible = stored.visible?.includes(def.id) ? true : stored.hidden?.includes(def.id) ? false : !!def.defaultVisible;
      this.objects.set(def.id, this.createObject(def, CATEGORY_INFO[def.category].color, visible, false));
    }
    for (const o of this.objects.values()) if (o.visible) this.ensureLoaded(o);
  }

  private createObject(def: ArtificialDef, color: string, visible: boolean, transient: boolean): ArtificialObject {
    let archive: HorizonsSource | undefined;
    if (def.source.type === 'tle') archive = { type: 'horizons', command: def.archive ?? String(-(100000 + def.source.norad)), step: '5 m', halfSpan: 0.25 };
    return {
      archive,
      def, color, visible, transient,
      status: 'idle', message: '', valid: false, mode: 'none',
      rel: new Vec3(), vel: new Vec3(),
      coverage: {}, historyStatus: 'idle', lastRequest: 0, pending: false,
    };
  }

  get(id: string): ArtificialObject | undefined {
    return this.objects.get(id);
  }

  list(): ArtificialObject[] {
    return [...this.objects.values()];
  }

  setVisible(id: string, visible: boolean): void {
    const o = this.objects.get(id);
    if (!o || o.visible === visible) return;
    o.visible = visible;
    if (visible) this.ensureLoaded(o);
    this.persist();
    this.onChange();
  }

  /** Rende "in evidenza" un satellite di un catalogo CelesTrak (dopo un clic o una ricerca). */
  promote(omm: OMM, color: string): ArtificialObject {
    const id = `sat-${omm.NORAD_CAT_ID}`;
    const existing = this.objects.get(id) ?? [...this.objects.values()].find(
      (o) => o.def.source.type === 'tle' && o.def.source.norad === Number(omm.NORAD_CAT_ID),
    );
    if (existing) {
      this.setVisible(existing.def.id, true);
      return existing;
    }
    const def: ArtificialDef = {
      id,
      name: omm.OBJECT_NAME,
      category: 'earth',
      categoryLabel: 'Catalogo CelesTrak',
      center: 'earth',
      source: { type: 'tle', norad: Number(omm.NORAD_CAT_ID) },
      operator: '—',
      launch: '',
      note: `Designatore internazionale ${omm.OBJECT_ID}, NORAD ${omm.NORAD_CAT_ID}.`,
    };
    const o = this.createObject(def, color, true, true);
    this.objects.set(id, o);
    this.applyOmm(o, omm);
    this.onChange();
    return o;
  }

  /** Rende "in evidenza" un corpo minore di un catalogo SBDB (nome completo JPL, es. "433 Eros (A898 PA)"). */
  promoteSmallBody(fullName: string, color: string): ArtificialObject {
    const name = fullName.trim();
    const num = /^(\d+)\s/.exec(name)?.[1];
    const des = /\(([^)]+)\)\s*$/.exec(name)?.[1];
    const command = num ? `${num};` : `DES=${des ?? name};`;
    const id = `sb-${(num ?? des ?? name).replace(/\W+/g, '_')}`;
    const existing = this.objects.get(id) ?? this.list().find((o) => o.def.source.type === 'horizons' && o.def.source.command === command);
    if (existing) {
      this.setVisible(existing.def.id, true);
      return existing;
    }
    const def: ArtificialDef = {
      id, name: name.replace(/^\d+\s+/, '').replace(/\s*\([^)]*\)\s*$/, '') || name, category: 'asteroid',
      categoryLabel: 'Catalogo JPL SBDB', center: 'sun', source: { type: 'horizons', command, step: '2 d', halfSpan: 60 },
      operator: 'corpo naturale', launch: '', note: name, sbdb: num ?? des ?? name,
    };
    const o = this.createObject(def, color, true, true);
    this.objects.set(id, o);
    this.ensureLoaded(o);
    this.onChange();
    return o;
  }

  private persist(): void {
    try {
      const all = this.list().filter((o) => !o.transient);
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...loadStored(),
          visible: all.filter((o) => o.visible).map((o) => o.def.id),
          hidden: all.filter((o) => !o.visible).map((o) => o.def.id),
        }),
      );
    } catch {
      /* archiviazione non disponibile: si usano i valori predefiniti */
    }
  }

  // ───────────────────────── Caricamento dati ─────────────────────────

  private ensureLoaded(o: ArtificialObject): void {
    if (o.def.sbdb && !o.physStatus) {
      o.physStatus = 'loading';
      fetchSbdb(o.def.sbdb)
        .then((p) => {
          o.phys = p;
          o.physStatus = 'ready';
          this.onChange();
        })
        .catch(() => (o.physStatus = 'error'));
    }
    if (o.status === 'loading' || o.status === 'ready') return;
    const src = o.def.source;
    if (src.type === 'tle') {
      o.status = 'loading';
      o.message = 'Scarico gli elementi orbitali da CelesTrak…';
      fetchCelestrak({ catnr: src.norad })
        .then((list) => {
          if (!list.length) throw new Error('Nessun elemento orbitale disponibile (oggetto rientrato?)');
          this.applyOmm(o, list[0]);
        })
        .catch((e: Error) => this.fail(o, e.message));
    } else {
      o.status = 'ready';
      o.message = '';
      this.requestWindow(o, this.sim.time);
      if (src.history) this.loadHistory(o);
      this.startDsn();
    }
  }

  private applyOmm(o: ArtificialObject, omm: OMM): void {
    try {
      o.satrec = json2satrec(omm);
      o.omm = omm;
      o.tleEpoch = simTimeFromDate(new Date(`${omm.EPOCH}Z`));
      o.status = 'ready';
      o.message = '';
    } catch (e) {
      this.fail(o, `TLE non valido: ${(e as Error).message}`);
    }
    this.onChange();
  }

  private fail(o: ArtificialObject, msg: string): void {
    o.status = 'error';
    o.message = msg;
    o.valid = false;
    this.onChange();
  }

  /** Richiede la tabella JPL per un intervallo allineato attorno a t (riutilizzabile dalla cache). */
  /** Sorgente Horizons effettiva: quella del catalogo o l'archivio storico dei satelliti. */
  private hzSource(o: ArtificialObject): HorizonsSource | null {
    if (o.def.source.type === 'horizons') return o.fine ? { ...o.def.source, step: '10 m', halfSpan: 1 } : o.def.source;
    return o.archive && !o.archiveUnavailable ? o.archive : null;
  }

  private requestWindow(o: ArtificialObject, t: number, retry = true): void {
    const src = this.hzSource(o);
    if (!src || o.pending) return;
    const now = performance.now();
    if (now - o.lastRequest < HORIZONS_THROTTLE) return;

    const half = src.halfSpan * DAY;
    const step = parseStep(src.step);
    let start = Math.floor(t / half) * half - half;
    let stop = start + 3 * half;
    if (o.coverage.start !== undefined) start = Math.max(start, o.coverage.start + step);
    if (o.coverage.end !== undefined) stop = Math.min(stop, o.coverage.end - step);
    if (stop - start < 2 * step) return; // t fuori dalla copertura JPL: resta l'estrapolazione

    o.pending = true;
    o.lastRequest = now;
    fetchHorizonsVectors({
      command: src.command, center: o.def.center, startJd: simTimeToJd(start), stopJd: simTimeToJd(stop), step: src.step,
    })
      .then((r) => {
        o.pending = false;
        const limit = r.error ? parseCoverageLimit(r.error) : null;
        if (limit) {
          if (limit.kind === 'prior') o.coverage.start = jdToSimTime(limit.jd);
          else o.coverage.end = jdToSimTime(limit.jd);
          if (retry) {
            o.lastRequest = 0;
            this.requestWindow(o, t, false);
          }
          return;
        }
        if (r.error) throw new Error(r.error);
        const pts = parseHorizonsVectors(r.result ?? '');
        if (pts.length < 2) throw new Error('Tabella JPL vuota');
        o.table = new TabulatedEphemeris(pts);
        o.status = 'ready';
        o.message = '';
        this.onChange();
      })
      .catch((e: Error) => {
        o.pending = false;
        if (o.def.source.type === 'tle') {
          o.archiveUnavailable = true; // nessun archivio JPL per questo satellite: resta SGP4
          return;
        }
        if (!o.table) this.fail(o, `JPL Horizons: ${e.message}`);
      });
  }

  /** Traiettoria storica dal lancio a un anno da oggi (600 intervalli). */
  private loadHistory(o: ArtificialObject, startOverride?: number, stopOverride?: number, retry = true): void {
    const src = o.def.source;
    if (src.type !== 'horizons') return;
    o.historyStatus = 'loading';
    const launch = simTimeFromDate(new Date(`${o.def.launch}T00:00:00Z`)) + DAY;
    const today = Math.floor(simTimeFromDate(new Date()) / DAY) * DAY;
    const recent = typeof src.history === 'number' ? today - src.history * DAY : -Infinity;
    const start = startOverride ?? Math.max(launch, recent);
    const stop = stopOverride ?? today + (typeof src.history === 'number' ? 90 : 365) * DAY;
    fetchHorizonsVectors({ command: src.command, center: o.def.center, startJd: simTimeToJd(start), stopJd: simTimeToJd(stop), step: '600' })
      .then((r) => {
        const limit = r.error ? parseCoverageLimit(r.error) : null;
        if (limit && retry) {
          const lt = jdToSimTime(limit.jd);
          if (limit.kind === 'prior') this.loadHistory(o, lt + 3600, stop, false);
          else this.loadHistory(o, start, lt - 3600, false);
          return;
        }
        if (r.error) throw new Error(r.error);
        o.history = parseHorizonsVectors(r.result ?? '').map((p) => p.r);
        o.historyStatus = 'ready';
        this.onChange();
      })
      .catch(() => {
        o.historyStatus = 'error';
      });
  }

  /** Stato dei collegamenti DSN: aggiornato ogni 10 s (dato in tempo reale, indipendente dal warp). */
  private startDsn(): void {
    if (this.dsnTimer) return;
    const poll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchDsnXml()
        .then((xml) => {
          this.dsn = parseDsnXml(xml);
          this.dsnError = '';
        })
        .catch((e: Error) => (this.dsnError = e.message));
    };
    poll();
    this.dsnTimer = setInterval(poll, 10_000);
  }

  // ───────────────────────── Aggiornamento per frame ─────────────────────────

  update(t: number): void {
    let M: ReturnType<typeof temeToEclipticMatrix> | null = null;
    const date = dateFromSimTime(t);
    for (const o of this.objects.values()) {
      if (!o.visible || o.status !== 'ready') continue;
      const launch = o.def.launch ? simTimeFromDate(new Date(`${o.def.launch}T00:00:00Z`)) : -Infinity;
      if (t < launch) {
        o.valid = false;
        o.mode = 'none';
        o.message = 'Non ancora lanciato a questa data';
        continue;
      }
      if (o.satrec) {
        const age = Math.abs(t - (o.tleEpoch ?? t));
        if (age > ARCHIVE_AGE && o.archive && !o.archiveUnavailable) {
          this.updateHorizons(o, t);
          if (o.valid && o.mode === 'tabulated') {
            o.mode = 'archive';
            o.message = '';
            continue;
          }
          if (o.archiveUnavailable === undefined || o.pending) o.message = 'Carico l\'archivio storico JPL…';
        }
        M ??= temeToEclipticMatrix(t);
        this.updateTle(o, date, M);
        if (age > ARCHIVE_AGE && o.archiveUnavailable) o.message = 'Archivio storico non disponibile: posizione estrapolata dal TLE attuale (indicativa)';
      } else if (o.def.source.type === 'horizons') {
        this.updateHorizons(o, t);
      }
    }
  }

  private updateTle(o: ArtificialObject, date: Date, M: ReturnType<typeof temeToEclipticMatrix>): void {
    const pv = propagate(o.satrec!, date);
    if (!pv) {
      o.valid = false;
      o.mode = 'none';
      o.message = 'SGP4: nessuna soluzione a questa data (oggetto rientrato o TLE troppo vecchio)';
      return;
    }
    const p = pv.position;
    const v = pv.velocity;
    if (!Number.isFinite(p.x) || !Number.isFinite(v.x)) {
      o.valid = false;
      o.mode = 'none';
      o.message = 'SGP4: soluzione non valida a questa data';
      return;
    }
    const r = [0, 0, 0];
    const w = [0, 0, 0];
    applyMat3(M, p.x, p.y, p.z, r);
    applyMat3(M, v.x, v.y, v.z, w);
    o.rel.x = r[0] * 1e3; o.rel.y = r[1] * 1e3; o.rel.z = r[2] * 1e3;
    o.vel.x = w[0] * 1e3; o.vel.y = w[1] * 1e3; o.vel.z = w[2] * 1e3;
    const g = eciToGeodetic(p, gstime(date));
    o.geodetic = { lat: (g.latitude * 180) / Math.PI, lon: (g.longitude * 180) / Math.PI, alt: g.height };
    o.valid = true;
    o.mode = 'sgp4';
    const age = Math.abs(this.sim.time - (o.tleEpoch ?? this.sim.time));
    o.message = age > 30 * DAY ? 'Data lontana dall\'epoca del TLE: posizione indicativa' : '';
  }

  /** Passa alla tabella a passo fine se l'oggetto eliocentrico è vicino a un pianeta (flyby). */
  private checkFine(o: ArtificialObject): void {
    if (o.def.center !== 'sun' || o.def.source.type !== 'horizons') return;
    const abs = this.sim.position('sun').add(o.rel);
    let near = false;
    for (const b of this.sim.bodies) {
      if ((b.kind === 'planet' || b.kind === 'dwarf') && Number.isFinite(b.soi) && abs.distanceTo(this.sim.position(b.id)) < b.soi) {
        near = true;
        break;
      }
    }
    if (near !== !!o.fine) {
      o.fine = near;
      o.lastRequest = 0;
      if (near) o.table = undefined; // la tabella a passo lungo non basta per un incontro ravvicinato
    }
  }

  private updateHorizons(o: ArtificialObject, t: number): void {
    const s = o.table?.stateAt(t);
    if (s) {
      o.rel = s.r;
      o.vel = s.v;
      o.valid = true;
      o.mode = 'tabulated';
      o.message = '';
      this.checkFine(o);
      if (!o.table) {
        this.requestWindow(o, t);
        return;
      }
      // Prefetch: se ci si avvicina al bordo della tabella, chiedi la successiva
      const src = this.hzSource(o);
      if (src && o.table) {
        const margin = (src.halfSpan * DAY) / 2;
        if (t > o.table.end - margin || t < o.table.start + margin) this.requestWindow(o, t);
      }
      return;
    }
    const p = o.table?.nearest(t);
    if (p) {
      const mu = this.sim.get(o.def.center).gm;
      const k = propagateKepler(p.r, p.v, mu, t - p.t);
      o.rel = k.r;
      o.vel = k.v;
      o.valid = true;
      o.mode = 'kepler';
      const beyond = (o.coverage.end !== undefined && t > o.coverage.end) || (o.coverage.start !== undefined && t < o.coverage.start);
      o.message = beyond ? 'Oltre la copertura delle effemeridi JPL: posizione estrapolata' : 'Aggiornamento dati JPL…';
    } else {
      o.valid = false;
      o.mode = 'none';
    }
    this.requestWindow(o, t);
  }

  // ───────────────────────── Telemetria ─────────────────────────

  telemetry(id: string): ArtificialTelemetry | null {
    const o = this.objects.get(id);
    if (!o || !o.valid) return null;
    const sim = this.sim;
    const center = sim.get(o.def.center);
    const abs = sim.position(center.id).add(o.rel);
    const absVel = sim.velocity(center.id).add(o.vel);
    const distEarth = abs.distanceTo(sim.position('earth'));
    const distSun = abs.distanceTo(sim.position('sun'));
    const distance = o.rel.length();
    const orbit = stateToElements(o.rel, o.vel, center.gm);
    const src = o.def.source;

    let source = '';
    let dataAge: number | undefined;
    if (o.mode === 'sgp4' && o.omm) {
      dataAge = sim.time - (o.tleEpoch ?? sim.time);
      source = `CelesTrak GP/TLE · SGP4 · epoca ${o.omm.EPOCH.replace('T', ' ').slice(0, 16)} UTC`;
    } else if (o.mode === 'archive') source = 'JPL Horizons · archivio storico dell\'orbita';
    else if (o.mode === 'tabulated') source = 'JPL Horizons · effemeride ufficiale (interpolata)';
    else if (o.mode === 'kepler') source = 'JPL Horizons · estrapolazione kepleriana';

    return {
      obj: o,
      centerName: center.name,
      distance,
      altitude: center.kind === 'star' ? undefined : distance - center.radius,
      speed: o.vel.length(),
      speedSun: absVel.sub(sim.velocity('sun')).length(),
      distEarth,
      distSun,
      lightTime: distEarth / C_LIGHT,
      orbit,
      inclinationEq: o.satrec ? (o.satrec.inclo * 180) / Math.PI : undefined,
      periodTle: o.satrec ? (2 * Math.PI) / o.satrec.no * 60 : undefined,
      dsn: src.type === 'horizons' && !o.def.sbdb ? linksForNaif(this.dsn, Number(src.command)) : [],
      dsnTime: this.dsn?.time,
      dataAge: o.mode === 'archive' ? undefined : dataAge,
      source,
      phys: o.phys,
    };
  }
}
