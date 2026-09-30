/**
 * Validazione della catena TLE → SGP4 → TEME → eclittica J2000:
 * confronta la posizione della ISS ottenuta dal TLE CelesTrak con l'effemeride JPL Horizons
 * della ISS (-125544) nello stesso istante, entrambe relative alla Terra.
 * Uso: node scripts/validate-iss.ts <file OMM json> (richiede rete per Horizons)
 */
import { readFileSync } from 'node:fs';
import { json2satrec, propagate } from 'satellite.js';
import { dateFromSimTime, simTimeFromDate } from '../src/physics/constants.ts';
import { horizonsVectorParams, parseHorizonsVectors, simTimeToJd } from '../src/spacecraft/horizons.ts';
import { applyMat3, temeToEclipticMatrix } from '../src/spacecraft/teme.ts';

const omm = JSON.parse(readFileSync(process.argv[2], 'utf8'))[0];
const satrec = json2satrec(omm);
const t = Math.round(simTimeFromDate(new Date(`${omm.EPOCH}Z`)) / 60) * 60 + 3 * 3600; // 3 h dopo l'epoca
const pv = propagate(satrec, dateFromSimTime(t))!;
const r = [0, 0, 0];
applyMat3(temeToEclipticMatrix(t), pv.position.x, pv.position.y, pv.position.z, r);

const p = horizonsVectorParams({ command: '-125544', center: 'earth', startJd: simTimeToJd(t), stopJd: simTimeToJd(t + 60), step: '1 m' });
const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?format=json&${new URLSearchParams(p)}`);
const json = (await res.json()) as { result: string; error?: string };
if (json.error) throw new Error(json.error);
const h = parseHorizonsVectors(json.result)[0];
const d = Math.hypot(h.r.x / 1e3 - r[0], h.r.y / 1e3 - r[1], h.r.z / 1e3 - r[2]);
console.log('SGP4 (eclittica J2000) km :', r.map((x) => x.toFixed(1)).join(', '));
console.log('JPL Horizons          km :', [h.r.x, h.r.y, h.r.z].map((x) => (x / 1e3).toFixed(1)).join(', '));
console.log(`Differenza: ${d.toFixed(2)} km (su ${Math.hypot(...r).toFixed(0)} km)`);
