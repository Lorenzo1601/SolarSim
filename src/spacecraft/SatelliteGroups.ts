/**
 * SatelliteGroups — cataloghi CelesTrak (Starlink, GNSS, geostazionari, detriti, …) mostrati come
 * nuvole di punti. Download tramite proxy locale, propagazione SGP4 in un Web Worker.
 */
import type { OMM } from './api.ts';
import { fetchCelestrak } from './api.ts';
import { SATELLITE_GROUPS, type SatelliteGroupDef } from './catalog.ts';
import type { WorkerRequest, WorkerResponse } from './satellite.worker.ts';

export interface SatelliteGroup {
  def: SatelliteGroupDef;
  visible: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  omms: OMM[];
  /** Ultime posizioni relative alla Terra [km, eclittica J2000], NaN se non valide. */
  positions: Float32Array | null;
  positionsTime: number;
  /** Incrementato a ogni nuovo set di posizioni. */
  version: number;
}

const STORAGE_KEY = 'solarsim.groups.v1';

export class SatelliteGroups {
  readonly groups = new Map<string, SatelliteGroup>();
  onChange: () => void = () => {};
  /** Durata dell'ultima propagazione nel worker [ms]. */
  lastPropagationMs = 0;
  private readonly worker: Worker;
  private busy = false;

  constructor() {
    this.worker = new Worker(new URL('./satellite.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onWorker(e.data);
    let stored: string[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      /* nessuna preferenza salvata */
    }
    for (const def of SATELLITE_GROUPS) {
      this.groups.set(def.id, {
        def, visible: false, status: 'idle', message: '', omms: [], positions: null, positionsTime: NaN, version: 0,
      });
    }
    for (const id of stored) this.setVisible(id, true);
  }

  private post(msg: WorkerRequest): void {
    this.worker.postMessage(msg);
  }

  setVisible(id: string, visible: boolean): void {
    const g = this.groups.get(id);
    if (!g) return;
    g.visible = visible;
    if (visible && g.status === 'idle') this.load(g);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.groups.values()].filter((x) => x.visible).map((x) => x.def.id)));
    } catch {
      /* ignora */
    }
    this.onChange();
  }

  private load(g: SatelliteGroup): void {
    g.status = 'loading';
    g.message = 'Scarico da CelesTrak…';
    fetchCelestrak({ group: g.def.group })
      .then((omms) => {
        g.omms = omms;
        g.message = `${omms.length.toLocaleString('it-IT')} oggetti`;
        this.post({ type: 'load', groupId: g.def.id, omms });
      })
      .catch((e: Error) => {
        g.status = 'error';
        g.message = e.message;
        this.onChange();
      });
    this.onChange();
  }

  private onWorker(msg: WorkerResponse): void {
    if (msg.type === 'loaded') {
      const g = this.groups.get(msg.groupId);
      if (g) {
        g.status = 'ready';
        if (msg.failed) g.message += ` (${msg.failed} non validi)`;
        this.onChange();
      }
    } else {
      this.busy = false;
      this.lastPropagationMs = msg.ms;
      for (const r of msg.groups) {
        const g = this.groups.get(r.groupId);
        if (!g) continue;
        g.positions = r.positions;
        g.positionsTime = msg.t;
        g.version++;
      }
    }
  }

  /** Chiede al worker le posizioni al tempo t, se non è già occupato. */
  tick(t: number): void {
    if (this.busy) return;
    const ids = [...this.groups.values()].filter((g) => g.visible && g.status === 'ready').map((g) => g.def.id);
    if (!ids.length) return;
    this.busy = true;
    this.post({ type: 'propagate', t, groupIds: ids });
  }

  /** Ricerca per nome o numero NORAD nei cataloghi caricati. */
  search(query: string, limit = 30): { omm: OMM; group: SatelliteGroup }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { omm: OMM; group: SatelliteGroup }[] = [];
    const seen = new Set<number>();
    for (const g of this.groups.values()) {
      for (const o of g.omms) {
        if (seen.has(o.NORAD_CAT_ID as number)) continue;
        if (o.OBJECT_NAME.toLowerCase().includes(q) || String(o.NORAD_CAT_ID) === q) {
          out.push({ omm: o, group: g });
          seen.add(o.NORAD_CAT_ID as number);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  findByNorad(norad: number): { omm: OMM; group: SatelliteGroup } | null {
    for (const g of this.groups.values()) {
      const o = g.omms.find((x) => Number(x.NORAD_CAT_ID) === norad);
      if (o) return { omm: o, group: g };
    }
    return null;
  }
}
