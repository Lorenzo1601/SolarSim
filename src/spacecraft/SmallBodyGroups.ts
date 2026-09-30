/**
 * SmallBodyGroups — cataloghi di asteroidi e oggetti transnettuniani dal JPL Small-Body Database,
 * mostrati come nuvole di punti eliocentriche (propagazione kepleriana in un Web Worker).
 */
import { fetchSmallBodies } from './api.ts';
import { SMALL_BODY_GROUPS, type SmallBodyGroupDef } from './catalog.ts';
import type { SmallBodyRequest, SmallBodyResponse } from './smallbody.worker.ts';

const STRIDE = 8;
const DEG = Math.PI / 180;
const STORAGE_KEY = 'solarsim.smallbodies.v1';

export interface SmallBodyGroup {
  def: SmallBodyGroupDef;
  visible: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  names: string[];
  count: number;
  /** Posizioni eliocentriche [AU], NaN se non valide. */
  positions: Float32Array | null;
  version: number;
}

export class SmallBodyGroups {
  readonly groups = new Map<string, SmallBodyGroup>();
  onChange: () => void = () => {};
  private readonly worker: Worker;
  private busy = false;

  constructor() {
    this.worker = new Worker(new URL('./smallbody.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<SmallBodyResponse>) => this.onWorker(e.data);
    for (const def of SMALL_BODY_GROUPS) {
      this.groups.set(def.id, { def, visible: false, status: 'idle', message: '', names: [], count: 0, positions: null, version: 0 });
    }
    let stored: string[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      /* nessuna preferenza */
    }
    for (const id of stored) this.setVisible(id, true);
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

  private load(g: SmallBodyGroup): void {
    g.status = 'loading';
    g.message = 'Scarico dal JPL Small-Body Database…';
    fetchSmallBodies(g.def.id)
      .then(({ fields, data }) => {
        const col = (n: string) => fields.indexOf(n);
        const [iN, iEp, iE, iA, iI, iOm, iW, iMa] = ['full_name', 'epoch', 'e', 'a', 'i', 'om', 'w', 'ma'].map(col);
        const el = new Float64Array(data.length * STRIDE);
        const names: string[] = [];
        data.forEach((row, k) => {
          const o = k * STRIDE;
          el[o] = Number(row[iA]);
          el[o + 1] = Number(row[iE]);
          el[o + 2] = Number(row[iI]) * DEG;
          el[o + 3] = Number(row[iOm]) * DEG;
          el[o + 4] = Number(row[iW]) * DEG;
          el[o + 5] = Number(row[iMa]) * DEG;
          el[o + 6] = Number(row[iEp]);
          names.push(String(row[iN] ?? '').trim());
        });
        g.names = names;
        g.count = names.length;
        g.message = `${names.length.toLocaleString('it-IT')} oggetti`;
        const req: SmallBodyRequest = { type: 'load', groupId: g.def.id, elements: el };
        this.worker.postMessage(req, [el.buffer]);
      })
      .catch((e: Error) => {
        g.status = 'error';
        g.message = e.message;
        this.onChange();
      });
    this.onChange();
  }

  private onWorker(msg: SmallBodyResponse): void {
    if (msg.type === 'loaded') {
      const g = this.groups.get(msg.groupId);
      if (g) {
        g.status = 'ready';
        this.onChange();
      }
      return;
    }
    this.busy = false;
    for (const r of msg.groups) {
      const g = this.groups.get(r.groupId);
      if (!g) continue;
      g.positions = r.positions;
      g.version++;
    }
  }

  tick(t: number): void {
    if (this.busy) return;
    const ids = [...this.groups.values()].filter((g) => g.visible && g.status === 'ready').map((g) => g.def.id);
    if (!ids.length) return;
    this.busy = true;
    const req: SmallBodyRequest = { type: 'propagate', t, groupIds: ids };
    this.worker.postMessage(req);
  }

  search(query: string, limit = 20): { name: string; group: SmallBodyGroup }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { name: string; group: SmallBodyGroup }[] = [];
    const seen = new Set<string>();
    for (const g of this.groups.values()) {
      for (const n of g.names) {
        if (seen.has(n) || !n.toLowerCase().includes(q)) continue;
        seen.add(n);
        out.push({ name: n, group: g });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Nome del corpo i-esimo del gruppo (per il picking). */
  nameAt(groupId: string, i: number): string | undefined {
    return this.groups.get(groupId)?.names[i];
  }
}
