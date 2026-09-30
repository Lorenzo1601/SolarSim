/** Accesso ai dati reali tramite il proxy locale di Vite (server/spaceDataPlugin.ts). */
import type { OMMJsonObject } from 'satellite.js';
import { horizonsVectorParams } from './horizons.ts';

export type OMM = OMMJsonObject;

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  return text;
}

/** Elementi GP (OMM JSON) da CelesTrak per gruppo o per numero NORAD. */
export async function fetchCelestrak(q: { group?: string; catnr?: number }): Promise<OMM[]> {
  const qs = q.group ? `GROUP=${encodeURIComponent(q.group)}` : `CATNR=${q.catnr}`;
  const text = await getText(`/api/celestrak?${qs}`);
  if (!text.trim().startsWith('[')) throw new Error(text.trim().slice(0, 160) || 'Risposta vuota');
  return JSON.parse(text) as OMM[];
}

export interface HorizonsResponse {
  result?: string;
  error?: string;
}

export async function fetchHorizonsVectors(opts: Parameters<typeof horizonsVectorParams>[0]): Promise<HorizonsResponse> {
  const qs = new URLSearchParams(horizonsVectorParams(opts)).toString();
  return JSON.parse(await getText(`/api/horizons?${qs}`)) as HorizonsResponse;
}

export async function fetchDsnXml(): Promise<string> {
  return getText('/api/dsn');
}

export interface SbdbPhys {
  fullname: string;
  kind: string;
  orbitClass: string;
  phys: Record<string, { value: string; units?: string }>;
}

/** Dati fisici di un corpo minore dal JPL Small-Body Database. */
export async function fetchSbdb(sstr: string): Promise<SbdbPhys> {
  const j = JSON.parse(await getText(`/api/sbdb?sstr=${encodeURIComponent(sstr)}`)) as {
    object?: { fullname: string; kind: string; orbit_class?: { name: string } };
    phys_par?: { name: string; value: string; units?: string }[];
    message?: string;
  };
  if (!j.object) throw new Error(j.message ?? 'Oggetto non trovato');
  const phys: SbdbPhys['phys'] = {};
  for (const p of j.phys_par ?? []) phys[p.name] = { value: p.value, units: p.units };
  return { fullname: j.object.fullname, kind: j.object.kind, orbitClass: j.object.orbit_class?.name ?? '', phys };
}

/** Elementi orbitali di un gruppo di corpi minori (JPL SBDB Query). */
export async function fetchSmallBodies(group: string): Promise<{ fields: string[]; data: (string | null)[][] }> {
  const j = JSON.parse(await getText(`/api/sbdbquery?group=${group}`)) as { fields?: string[]; data?: (string | null)[][]; message?: string };
  if (!j.fields || !j.data) throw new Error(j.message ?? 'Risposta non valida');
  return { fields: j.fields, data: j.data };
}
