/**
 * Plugin Vite: piccolo proxy locale con cache su disco per i dati spaziali reali.
 *
 *   /api/celestrak?GROUP=stations | ?CATNR=25544   → CelesTrak GP (JSON OMM)      cache 2 h
 *   /api/horizons?COMMAND=...&CENTER=...            → JPL Horizons API (JSON)       cache 12 h
 *   /api/dsn                                        → NASA DSN Now (XML)            cache 5 s
 *   /api/sbdb?sstr=433                              → JPL Small-Body Database       cache 30 giorni
 *   /api/sbdbquery?group=neo|pha|big|tjn|tno        → JPL SBDB Query (elementi)     cache 7 giorni
 *   /api/tile?src=esri|s2&z=&x=&y=                  → immagini satellitari (tile)   cache 90 giorni
 *   /api/terrain?z=&x=&y=                           → quote del terreno (Terrarium) cache 1 anno
 *
 * Perché un proxy:
 *  - CelesTrak e Horizons non inviano intestazioni CORS: il browser non può interrogarli direttamente;
 *  - CelesTrak chiede di non scaricare gli stessi dati più di una volta ogni 2 ore
 *    (e blocca chi esagera): la cache su disco (.cache/space-data) evita richieste ripetute
 *    anche quando si ricarica la pagina o si riavvia `npm run dev`;
 *  - se la rete non è disponibile si continua a servire l'ultima copia (anche scaduta).
 *
 * Funziona con `npm run dev` e `npm run preview`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

interface CacheEntry {
  key: string;
  fetchedAt: number;
  status: number;
  contentType: string;
  body: string;
  /** body in base64 (immagini). */
  binary?: boolean;
}

interface Route {
  /** Durata della cache [ms]. */
  ttl: number;
  /** Salva anche su disco. */
  persist: boolean;
  /** Richieste contemporanee massime verso l'origine. */
  concurrency: number;
  /** URL remoto a partire dalla query, o null se la query non è valida. */
  upstream(q: URLSearchParams): string | null;
  /** Risposta binaria (immagini): salvata in base64. */
  binary?: boolean;
}

/** z/x/y di una tile validi (interi, dentro la griglia del livello). */
function tileXYZ(q: URLSearchParams, maxZ: number): { z: number; x: number; y: number } | null {
  const z = Number(q.get('z'));
  const x = Number(q.get('x'));
  const y = Number(q.get('y'));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > maxZ) return null;
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return null;
  return { z, x, y };
}

const USER_AGENT = 'SolarSim/0.1 (simulatore didattico locale; https://github.com/)';

const HORIZONS_KEYS = [
  'COMMAND', 'CENTER', 'MAKE_EPHEM', 'EPHEM_TYPE', 'OBJ_DATA', 'START_TIME', 'STOP_TIME', 'STEP_SIZE',
  'REF_PLANE', 'REF_SYSTEM', 'VEC_TABLE', 'OUT_UNITS', 'CSV_FORMAT', 'VEC_LABELS', 'TLIST',
];

const ROUTES: Record<string, Route> = {
  '/api/celestrak': {
    ttl: 2 * 3600e3,
    persist: true,
    concurrency: 2,
    upstream(q) {
      const group = q.get('GROUP');
      const catnr = q.get('CATNR');
      if (group && /^[a-z0-9-]{1,40}$/i.test(group)) {
        return `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
      }
      if (catnr && /^\d{1,9}$/.test(catnr)) {
        return `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catnr}&FORMAT=json`;
      }
      return null;
    },
  },
  '/api/horizons': {
    ttl: 12 * 3600e3,
    persist: true,
    concurrency: 2,
    upstream(q) {
      if (!q.get('COMMAND')) return null;
      const out = new URLSearchParams({ format: 'json' });
      for (const k of HORIZONS_KEYS) {
        const v = q.get(k);
        if (v !== null) out.set(k, v);
      }
      return `https://ssd.jpl.nasa.gov/api/horizons.api?${out.toString()}`;
    },
  },
  '/api/sbdb': {
    ttl: 30 * 86400e3,
    persist: true,
    concurrency: 2,
    upstream(q) {
      const sstr = q.get('sstr');
      if (!sstr || !/^[\w ()-]{1,40}$/.test(sstr)) return null;
      return `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(sstr)}&phys-par=1`;
    },
  },
  '/api/sbdbquery': {
    ttl: 7 * 86400e3,
    persist: true,
    concurrency: 1,
    upstream(q) {
      const groups: Record<string, string> = {
        neo: 'sb-group=neo',
        pha: 'sb-group=pha',
        big: 'sb-kind=a&sb-cdata=' + encodeURIComponent('{"AND":["H|LT|13"]}'),
        tjn: 'sb-class=TJN',
        tno: 'sb-class=TNO',
      };
      const g = groups[q.get('group') ?? ''];
      if (!g) return null;
      return `https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=full_name,epoch,e,a,i,om,w,ma&full-prec=1&${g}`;
    },
  },
  '/api/tile': {
    ttl: 90 * 86400e3,
    persist: true,
    concurrency: 6,
    binary: true,
    upstream(q) {
      const src = q.get('src') ?? 'esri';
      const t = tileXYZ(q, src === 's2' ? 15 : 19);
      if (!t) return null;
      if (src === 's2') return `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/${t.z}/${t.y}/${t.x}.jpg`;
      if (src === 'esri') return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${t.z}/${t.y}/${t.x}`;
      return null;
    },
  },
  '/api/terrain': {
    ttl: 365 * 86400e3,
    persist: true,
    concurrency: 4,
    binary: true,
    upstream(q) {
      const t = tileXYZ(q, 15);
      return t ? `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png` : null;
    },
  },
  '/api/dsn': {
    ttl: 5e3,
    persist: false,
    concurrency: 1,
    upstream: () => `https://eyes.nasa.gov/dsn/data/dsn.xml?r=${Math.floor(Date.now() / 5000)}`,
  },
};

/** Coda con limite di concorrenza per ciascuna origine. */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export function spaceDataPlugin(options: { cacheDir?: string } = {}): Plugin {
  let cacheDir = '';
  const memory = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CacheEntry>>();
  const limiters = new Map<string, Limiter>();

  const fileFor = (key: string) => path.join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);

  async function readCached(key: string, route: Route): Promise<CacheEntry | undefined> {
    const m = memory.get(key);
    if (m || !route.persist) return m;
    try {
      const e = JSON.parse(await readFile(fileFor(key), 'utf8')) as CacheEntry;
      if (!route.binary) memory.set(key, e); // le immagini restano solo su disco (sarebbero migliaia)
      return e;
    } catch {
      return undefined;
    }
  }

  async function fetchUpstream(prefix: string, route: Route, key: string, url: string): Promise<CacheEntry> {
    let limiter = limiters.get(prefix);
    if (!limiter) limiters.set(prefix, (limiter = new Limiter(route.concurrency)));
    return limiter.run(async () => {
      let res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60e3) });
      // servizio momentaneamente sovraccarico: riprova con attesa crescente
      for (let k = 1; k <= 2 && (res.status === 503 || res.status === 429); k++) {
        await new Promise((r) => setTimeout(r, 1500 * k));
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60e3) });
      }
      const body = route.binary && res.ok ? Buffer.from(await res.arrayBuffer()).toString('base64') : await res.text();
      const entry: CacheEntry = {
        key,
        fetchedAt: Date.now(),
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'text/plain',
        body,
        binary: route.binary && res.ok,
      };
      if (res.ok) {
        if (!route.binary) memory.set(key, entry);
        if (route.persist) {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(fileFor(key), JSON.stringify(entry));
        }
      }
      return entry;
    });
  }

  function send(res: ServerResponse, e: CacheEntry, cache: string): void {
    res.statusCode = e.status;
    res.setHeader('Content-Type', e.contentType);
    res.setHeader('X-Cache', cache);
    res.setHeader('X-Fetched-At', String(e.fetchedAt));
    if (e.binary) res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(e.binary ? Buffer.from(e.body, 'base64') : e.body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = ROUTES[url.pathname];
    if (!route) return next();
    const upstream = route.upstream(url.searchParams);
    if (!upstream) {
      res.statusCode = 400;
      res.end('Parametri non validi');
      return;
    }
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const key = `${url.pathname}?${new URLSearchParams(params).toString()}`;

    const cached = await readCached(key, route);
    if (cached && Date.now() - cached.fetchedAt < route.ttl) return send(res, cached, 'HIT');

    let p = inflight.get(key);
    if (!p) {
      p = fetchUpstream(url.pathname, route, key, upstream).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    try {
      const fresh = await p;
      if (fresh.status >= 400 && cached) return send(res, cached, 'STALE');
      send(res, fresh, 'MISS');
    } catch (err) {
      if (cached) return send(res, cached, 'STALE');
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Sorgente non raggiungibile: ${(err as Error).message}` }));
    }
  }

  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    handle(req, res, next).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  };

  return {
    name: 'solarsim-space-data',
    configResolved(config) {
      cacheDir = options.cacheDir ?? path.resolve(config.root, '.cache/space-data');
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
