/**
 * Sincronizzazione dei corpi naturali con le effemeridi JPL (DE440 via Horizons).
 *
 * All'avvio e a ogni salto di data le posizioni e velocità "vere" di Sole, pianeti e lune vengono
 * scaricate da JPL Horizons (baricentro del Sistema Solare, eclittica J2000) e impostate nel motore
 * N-body, che poi prosegue da solo. Gli elementi kepleriani medi del catalogo restano come riserva
 * (fuori rete o fuori dal periodo coperto da JPL).
 */
import type { Simulation } from '../physics/simulation.ts';
import type { Vec3 } from '../physics/vec3.ts';
import { fetchHorizonsVectors } from './api.ts';
import { parseHorizonsVectors, simTimeToJd } from './horizons.ts';

/** Codici NAIF dei corpi del catalogo. */
export const NAIF: Record<string, string> = {
  sun: '10', mercury: '199', venus: '299', earth: '399', moon: '301', mars: '499', phobos: '401', deimos: '402',
  jupiter: '599', io: '501', europa: '502', ganymede: '503', callisto: '504', saturn: '699', titan: '606',
  uranus: '799', titania: '703', oberon: '704', neptune: '899', triton: '801', pluto: '999', charon: '901',
};

export type SyncStatus = 'idle' | 'loading' | 'ok' | 'partial' | 'error';

export class EphemerisSync {
  status: SyncStatus = 'idle';
  /** Istante dell'ultima sincronizzazione riuscita [s da J2000]. */
  syncedAt = NaN;
  bodies = 0;
  private token = 0;
  private readonly sim: Simulation;
  /** Chiamata dopo l'applicazione dei nuovi stati. */
  onApplied: () => void = () => {};

  constructor(sim: Simulation) {
    this.sim = sim;
  }

  /** Scarica gli stati JPL al tempo t (arrotondato al minuto) e li applica al motore. */
  async sync(t: number = this.sim.time): Promise<void> {
    const token = ++this.token;
    const t0 = Math.floor(t / 60) * 60;
    const jd = simTimeToJd(t0);
    this.status = 'loading';
    const ids = this.sim.bodies.filter((b) => b.def && NAIF[b.id]).map((b) => b.id);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await fetchHorizonsVectors({ command: NAIF[id], center: '500@0', startJd: jd, stopJd: jd + 1 / 1440, step: '1' });
          const p = r.error ? [] : parseHorizonsVectors(r.result ?? '');
          return p.length ? { id, r: p[0].r, v: p[0].v } : null;
        } catch {
          return null;
        }
      }),
    );
    if (token !== this.token) return; // superata da una richiesta più recente
    const ok = results.filter((x): x is { id: string; r: Vec3; v: Vec3 } => !!x);
    if (!ok.length) {
      this.status = 'error';
      return;
    }
    const sim = this.sim;
    const now = sim.time;
    // riporta la simulazione all'istante dei dati, applica gli stati e ritorna al tempo corrente
    if (Math.abs(now - t0) < 60 * 86400) {
      sim.resetToTime(t0);
      for (const s of ok) sim.system.setState(sim.get(s.id).index, s.r, s.v);
      if (now > t0) sim.advance(now - t0);
      else if (now < t0) sim.resetToTime(now); // (caso raro) si torna al modello kepleriano
    }
    this.status = ok.length === ids.length ? 'ok' : 'partial';
    this.bodies = ok.length;
    this.syncedAt = t0;
    this.onApplied();
  }
}
