/**
 * Web Worker: propagazione SGP4 in blocco dei cataloghi CelesTrak (anche >10.000 satelliti)
 * fuori dal thread di rendering. Restituisce le posizioni relative alla Terra in km,
 * già nel frame del motore (eclittica J2000), come Float32Array trasferibili.
 */
import { json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js';
import { dateFromSimTime } from '../physics/constants.ts';
import { applyMat3, temeToEclipticMatrix } from './teme.ts';

export type WorkerRequest =
  | { type: 'load'; groupId: string; omms: OMMJsonObject[] }
  | { type: 'unload'; groupId: string }
  | { type: 'propagate'; t: number; groupIds: string[] };

export type WorkerResponse =
  | { type: 'loaded'; groupId: string; count: number; failed: number }
  | { type: 'positions'; t: number; groups: { groupId: string; positions: Float32Array }[]; ms: number };

const groups = new Map<string, (SatRec | null)[]>();
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    let failed = 0;
    const recs = msg.omms.map((o) => {
      try {
        return json2satrec(o);
      } catch {
        failed++;
        return null;
      }
    });
    groups.set(msg.groupId, recs);
    ctx.postMessage({ type: 'loaded', groupId: msg.groupId, count: recs.length, failed });
  } else if (msg.type === 'unload') {
    groups.delete(msg.groupId);
  } else if (msg.type === 'propagate') {
    const t0 = performance.now();
    const date = dateFromSimTime(msg.t);
    const M = temeToEclipticMatrix(msg.t);
    const out: { groupId: string; positions: Float32Array }[] = [];
    const tmp = [0, 0, 0];
    for (const id of msg.groupIds) {
      const recs = groups.get(id);
      if (!recs) continue;
      const pos = new Float32Array(recs.length * 3);
      for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        const pv = rec ? propagate(rec, date) : null;
        if (!pv) {
          pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = NaN;
          continue;
        }
        applyMat3(M, pv.position.x, pv.position.y, pv.position.z, tmp);
        pos[i * 3] = tmp[0];
        pos[i * 3 + 1] = tmp[1];
        pos[i * 3 + 2] = tmp[2];
      }
      out.push({ groupId: id, positions: pos });
    }
    ctx.postMessage(
      { type: 'positions', t: msg.t, groups: out, ms: performance.now() - t0 },
      out.map((g) => g.positions.buffer),
    );
  }
};
