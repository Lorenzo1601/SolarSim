/**
 * Web Worker: posizioni eliocentriche di migliaia di asteroidi con la propagazione kepleriana
 * degli elementi osculanti JPL (eclittica J2000). Output in AU (Float32Array trasferibile).
 */
import { simTimeToJd } from './horizons.ts';

export type SmallBodyRequest =
  | { type: 'load'; groupId: string; elements: Float64Array }
  | { type: 'propagate'; t: number; groupIds: string[] };

export type SmallBodyResponse =
  | { type: 'loaded'; groupId: string; count: number }
  | { type: 'positions'; t: number; groups: { groupId: string; positions: Float32Array }[] };

/** Elementi per corpo: a [AU], e, i, Ω, ω, M0 [rad], epoca [JD TDB], n [rad/giorno]. */
export const STRIDE = 8;
const K_GAUSS = 0.01720209895; // costante di Gauss [rad/giorno] per a in AU

const groups = new Map<string, Float64Array>();
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SmallBodyRequest>) => void) | null;
  postMessage(msg: SmallBodyResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    const el = msg.elements;
    for (let k = 0; k < el.length; k += STRIDE) el[k + 7] = K_GAUSS / Math.pow(el[k], 1.5);
    groups.set(msg.groupId, el);
    ctx.postMessage({ type: 'loaded', groupId: msg.groupId, count: el.length / STRIDE });
    return;
  }
  const jd = simTimeToJd(msg.t);
  const out: { groupId: string; positions: Float32Array }[] = [];
  for (const id of msg.groupIds) {
    const el = groups.get(id);
    if (!el) continue;
    const n = el.length / STRIDE;
    const pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const o = k * STRIDE;
      const a = el[o], e = el[o + 1], inc = el[o + 2], node = el[o + 3], argp = el[o + 4];
      if (!(e < 1) || !(a > 0)) {
        pos[k * 3] = pos[k * 3 + 1] = pos[k * 3 + 2] = NaN;
        continue;
      }
      let M = (el[o + 5] + el[o + 7] * (jd - el[o + 6])) % (2 * Math.PI);
      if (M < 0) M += 2 * Math.PI;
      let E = e < 0.8 ? M : Math.PI;
      for (let it = 0; it < 12; it++) {
        const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        E -= d;
        if (Math.abs(d) < 1e-10) break;
      }
      const x = a * (Math.cos(E) - e);
      const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
      const cO = Math.cos(node), sO = Math.sin(node), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(inc), si = Math.sin(inc);
      pos[k * 3] = (cO * cw - sO * sw * ci) * x + (-cO * sw - sO * cw * ci) * y;
      pos[k * 3 + 1] = (sO * cw + cO * sw * ci) * x + (-sO * sw + cO * cw * ci) * y;
      pos[k * 3 + 2] = sw * si * x + cw * si * y;
    }
    out.push({ groupId: id, positions: pos });
  }
  ctx.postMessage({ type: 'positions', t: msg.t, groups: out }, out.map((g) => g.positions.buffer));
};
