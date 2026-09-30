/**
 * NASA Deep Space Network "DSN Now" (https://eyes.nasa.gov/dsn/): stato in tempo reale delle
 * antenne di Goldstone, Madrid e Canberra e dei collegamenti con le sonde.
 * Parser senza DOM (funziona anche nei test Node).
 */

export interface DsnLink {
  /** Complesso (Goldstone, Madrid, Canberra). */
  station: string;
  /** Antenna (es. DSS43). */
  dish: string;
  activity: string;
  /** Sigla DSN della sonda (es. VGR1). */
  spacecraft: string;
  /** Id DSN = −(id NAIF) (es. 31 per Voyager 1, NAIF −31). */
  spacecraftId: number;
  /** Velocità dati in discesa/salita [bit/s] (se il segnale è attivo). */
  downRate?: number;
  upRate?: number;
  band?: string;
  /** Potenza ricevuta [dBm]. */
  downPower?: number;
  /** Distanza [km] (−1 se non disponibile). */
  rangeKm?: number;
  /** Tempo luce andata e ritorno [s]. */
  rtlt?: number;
}

export interface DsnSnapshot {
  /** Istante della fotografia (ms UTC). */
  time: number;
  links: DsnLink[];
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const num = (s: string | undefined) => {
  const x = Number(s);
  return s !== undefined && s !== '' && Number.isFinite(x) ? x : undefined;
};

export function parseDsnXml(xml: string): DsnSnapshot {
  const links: DsnLink[] = [];
  let station = '';
  let time = Date.now();
  let dish: { name: string; activity: string } | null = null;
  let down: Record<string, Record<string, string>> = {};
  let up: Record<string, Record<string, string>> = {};
  let targets: Record<string, string>[] = [];

  const flush = () => {
    if (!dish) return;
    for (const tg of targets) {
      const id = Number(tg.id);
      if (!Number.isFinite(id) || id <= 0 || id === 99) continue; // 99 = "DSN" (test/manutenzione)
      const d = down[String(id)];
      const u = up[String(id)];
      const range = num(tg.downlegRange) ?? num(tg.uplegRange);
      links.push({
        station,
        dish: dish.name,
        activity: dish.activity,
        spacecraft: tg.name,
        spacecraftId: id,
        downRate: d ? num(d.dataRate) : undefined,
        upRate: u ? num(u.dataRate) : undefined,
        band: d?.band ?? u?.band,
        downPower: d ? num(d.power) : undefined,
        rangeKm: range !== undefined && range > 0 ? range : undefined,
        rtlt: num(tg.rtlt) !== undefined && Number(tg.rtlt) > 0 ? Number(tg.rtlt) : undefined,
      });
    }
    dish = null;
    down = {};
    up = {};
    targets = [];
  };

  for (const m of xml.matchAll(/<(\/?)(station|dish|downSignal|upSignal|target|timestamp)\b([^>]*)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2];
    const a = closing ? {} : attrs(m[3]);
    if (tag === 'dish' && closing) flush();
    else if (tag === 'station') {
      flush();
      station = a.friendlyName || a.name || station;
      const ts = num(a.timeUTC);
      if (ts) time = ts;
    } else if (tag === 'dish') {
      flush();
      dish = { name: a.name ?? '', activity: a.activity ?? '' };
    } else if ((tag === 'downSignal' || tag === 'upSignal') && a.active === 'true' && a.spacecraftID) {
      // Nei segnali l'id può comparire negativo (-74), nel target positivo (74): si normalizza
      (tag === 'downSignal' ? down : up)[String(Math.abs(Number(a.spacecraftID)))] = a;
    } else if (tag === 'target') {
      targets.push(a);
    }
  }
  flush();
  return { time, links };
}

/** Collegamenti attivi per una sonda dato il suo id NAIF (negativo). */
export function linksForNaif(snapshot: DsnSnapshot | null, naifId: number): DsnLink[] {
  if (!snapshot) return [];
  return snapshot.links.filter((l) => l.spacecraftId === -naifId);
}
