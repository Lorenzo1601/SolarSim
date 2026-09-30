/** Test dei moduli per gli oggetti artificiali (dati reali salvati in tests/fixtures). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { json2satrec, propagate } from 'satellite.js';
import { AU, DAY, DEG, JULIAN_YEAR, dateFromSimTime, simTimeFromDate } from '../src/physics/constants.ts';
import { poleVectorEcliptic } from '../src/physics/frames.ts';
import { elementsToState, propagateKepler } from '../src/physics/kepler.ts';
import { Vec3 } from '../src/physics/vec3.ts';
import { FEATURED, SATELLITE_GROUPS } from '../src/spacecraft/catalog.ts';
import { linksForNaif, parseDsnXml } from '../src/spacecraft/dsn.ts';
import {
  TabulatedEphemeris, hermite, jdToSimTime, parseCoverageLimit, parseHorizonsVectors, simTimeToJd,
  type EphemPoint,
} from '../src/spacecraft/horizons.ts';
import { applyMat3, precessionMatrix, temeToEclipticMatrix } from '../src/spacecraft/teme.ts';

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const MU_SUN = 1.32712440041279e20;
const MU_EARTH = 3.98600435507e14;

describe('TEME → eclittica J2000', () => {
  it('la precessione è una rotazione di ~50,3″/anno attorno al polo dell\'eclittica', () => {
    const t = 25 * JULIAN_YEAR;
    const P = precessionMatrix(t);
    const trace = P[0] + P[4] + P[8];
    const angle = Math.acos((trace - 1) / 2) / DEG * 3600; // arcosecondi
    assert.ok(Math.abs(angle - 25 * 50.29) < 25 * 0.5, `angolo ${angle}″`);
    // ortonormale
    const col = (j: number) => new Vec3(P[j], P[3 + j], P[6 + j]);
    assert.ok(Math.abs(col(0).dot(col(1))) < 1e-14 && Math.abs(col(0).length() - 1) < 1e-14);
  });

  it('a J2000 la matrice coincide con la sola rotazione equatore → eclittica', () => {
    const M = temeToEclipticMatrix(0);
    const out = [0, 0, 0];
    applyMat3(M, 0, 0, 1, out); // polo nord celeste
    const pole = poleVectorEcliptic(0, 90);
    assert.ok(Math.hypot(out[0] - pole.x, out[1] - pole.y, out[2] - pole.z) < 1e-12);
  });

  it('ISS da TLE reale: quota ~400 km, velocità ~7,66 km/s', () => {
    const omm = JSON.parse(fixture('iss-omm.json'))[0];
    const rec = json2satrec(omm);
    const t = simTimeFromDate(new Date(`${omm.EPOCH}Z`)) + 3600;
    const pv = propagate(rec, dateFromSimTime(t))!;
    const r = [0, 0, 0];
    applyMat3(temeToEclipticMatrix(t), pv.position.x, pv.position.y, pv.position.z, r);
    const alt = Math.hypot(...r) - 6371;
    assert.ok(alt > 350 && alt < 460, `quota ${alt}`);
    const v = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    assert.ok(Math.abs(v - 7.66) < 0.08, `v ${v}`);
  });
});

describe('JPL Horizons', () => {
  it('parsing della tabella di vettori (Voyager 1, dati reali)', () => {
    const pts = parseHorizonsVectors(JSON.parse(fixture('horizons-voyager1.json')).result);
    assert.equal(pts.length, 3);
    const d = pts[0].r.length() / AU;
    assert.ok(d > 160 && d < 185, `distanza ${d} AU`);
    const v = pts[0].v.length() / 1000;
    assert.ok(v > 16 && v < 17.5, `velocità ${v} km/s`);
    assert.ok(Math.abs(pts[1].t - pts[0].t - 5 * DAY) < 1e-6);
  });

  it('conversione tempi UTC ↔ TDB', () => {
    assert.ok(Math.abs(jdToSimTime(simTimeToJd(123456.789)) - 123456.789) < 1e-3);
    assert.ok(Math.abs((simTimeToJd(0) - 2451545) * DAY - 69.184) < 1e-3);
  });

  it('riconosce i limiti di copertura', () => {
    const err = JSON.parse(fixture('horizons-error.json')).error as string;
    const lim = parseCoverageLimit(err)!;
    assert.equal(lim.kind, 'prior');
    const d = new Date((lim.jd - 2440587.5) * 86400000);
    assert.equal(d.toISOString().slice(0, 16), '1977-09-05T13:59');
    assert.equal(parseCoverageLimit('No ephemeris for target "X" after A.D. 2026-MAR-01 01:00:00.0000 TDB')?.kind, 'after');
    assert.equal(parseCoverageLimit('altro errore'), null);
  });

  it('Hermite: errore < 1 km su un\'orbita terrestre campionata ogni 5 minuti', () => {
    const el = { a: 7000e3, e: 0.05, i: 0.9, raan: 1, argp: 2, M: 0 };
    const pts: EphemPoint[] = [];
    let s = elementsToState(el, MU_EARTH);
    for (let k = 0; k <= 20; k++) {
      pts.push({ t: k * 300, r: s.r, v: s.v });
      s = propagateKepler(s.r, s.v, MU_EARTH, 300);
    }
    const tab = new TabulatedEphemeris(pts);
    let maxErr = 0;
    for (let t = 0; t <= 6000; t += 37) {
      const exact = propagateKepler(pts[0].r, pts[0].v, MU_EARTH, t);
      maxErr = Math.max(maxErr, tab.stateAt(t)!.r.distanceTo(exact.r));
    }
    assert.ok(maxErr < 1000, `errore max ${maxErr} m`);
    assert.equal(tab.stateAt(-1), null);
    assert.equal(tab.stateAt(6001), null);
    // agli estremi l'interpolazione restituisce esattamente i punti tabulati
    assert.ok(hermite(pts[0], pts[1], 0).r.distanceTo(pts[0].r) < 1e-6);
  });

  it('propagazione kepleriana iperbolica (tipo Voyager) coerente con la vis-viva', () => {
    const r = new Vec3(160 * AU, 0, 0);
    const v = new Vec3(3000, 16000, 2000);
    const k = propagateKepler(r, v, MU_SUN, 365 * DAY);
    const e0 = v.lengthSq() / 2 - MU_SUN / r.length();
    const e1 = k.v.lengthSq() / 2 - MU_SUN / k.r.length();
    assert.ok(Math.abs((e1 - e0) / e0) < 1e-9);
    assert.ok(k.r.distanceTo(r) > 3 * AU);
  });
});

describe('NASA DSN Now', () => {
  it('parsing di una fotografia reale', () => {
    const snap = parseDsnXml(fixture('dsn.xml'));
    assert.ok(snap.links.length > 0);
    assert.ok(snap.links.every((l) => l.spacecraftId !== 99 && l.station && l.dish));
    const mro = linksForNaif(snap, -74);
    assert.ok(mro.length > 0, 'MRO presente nella fotografia');
    assert.ok(mro.some((l) => (l.downRate ?? 0) > 0), 'segnale in discesa di MRO associato (id negativo nel segnale)');
  });

  it('XML sintetico: distanza, RTLT e velocità dati', () => {
    const xml = `<dsn><station name="cdscc" friendlyName="Canberra" timeUTC="1790000000000"/>
      <dish name="DSS43" activity="Spacecraft Telemetry">
        <downSignal active="true" signalType="data" dataRate="160" band="X" power="-157.2" spacecraft="VGR1" spacecraftID="-31"/>
        <upSignal active="false" dataRate="16" spacecraft="VGR1" spacecraftID="-31"/>
        <target name="VGR1" id="31" uplegRange="2.5e10" downlegRange="2.5e10" rtlt="166800"/>
      </dish></dsn>`;
    const [l] = linksForNaif(parseDsnXml(xml), -31);
    assert.equal(l.station, 'Canberra');
    assert.equal(l.downRate, 160);
    assert.equal(l.upRate, undefined);
    assert.equal(l.rangeKm, 2.5e10);
    assert.equal(l.rtlt, 166800);
  });
});

describe('Catalogo', () => {
  it('id univoci, centri validi, date di lancio ISO', () => {
    const ids = new Set(FEATURED.map((d) => d.id));
    assert.equal(ids.size, FEATURED.length);
    for (const d of FEATURED) {
      assert.ok(['sun', 'earth', 'moon', 'mars', 'jupiter'].includes(d.center), d.id);
      if (d.category === 'asteroid' || d.category === 'tno') assert.equal(d.launch, '', d.id);
      else assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d.launch), d.id);
      if (d.source.type === 'tle') assert.equal(d.center, 'earth');
    }
    assert.equal(new Set(SATELLITE_GROUPS.map((g) => g.id)).size, SATELLITE_GROUPS.length);
  });
});
