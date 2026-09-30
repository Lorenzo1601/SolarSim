/**
 * Catalogo dei corpi del Sistema Solare.
 *
 * Fonti:
 *  - Elementi planetari: E.M. Standish (JPL), "Keplerian Elements for Approximate Positions of the
 *    Major Planets", tabella 1 (eclittica/equinozio J2000, valida 1800–2050). Per la Terra gli
 *    elementi sono quelli del baricentro Terra–Luna; per tutti i pianeti vengono usati come orbita
 *    del baricentro del sistema pianeta+lune.
 *  - GM: JPL DE440 / soluzioni satellitari JPL (km^3/s^2, qui convertiti in m^3/s^2).
 *  - Raggi medi, periodi di rotazione e poli: IAU WGCCRE.
 *  - Elementi delle lune: elementi medi JPL (relativi al piano equatoriale/di Laplace del pianeta);
 *    Luna: elementi medi di P. Schlyter (eclittica). Le fasi sono approssimate: i piani orbitali
 *    e i periodi sono realistici, la posizione istantanea delle lune può differire da quella reale.
 */
import { KM, KM3S2 } from '../physics/constants.ts';

export type BodyKind = 'star' | 'planet' | 'dwarf' | 'moon';

/** Elementi kepleriani eliocentrici + variazioni secolari (per secolo giuliano da J2000). */
export interface PlanetElements {
  /** Semiasse maggiore [AU] */
  a: number;
  e: number;
  /** Inclinazione [°] */
  I: number;
  /** Longitudine media [°] */
  L: number;
  /** Longitudine del perielio ϖ = Ω + ω [°] */
  varpi: number;
  /** Longitudine del nodo ascendente Ω [°] */
  node: number;
  aDot: number;
  eDot: number;
  IDot: number;
  LDot: number;
  varpiDot: number;
  nodeDot: number;
}

/** Elementi orbitali di una luna rispetto al pianeta. */
export interface MoonElements {
  /** Semiasse maggiore [km] */
  a: number;
  e: number;
  /** [°] */
  i: number;
  node: number;
  argp: number;
  /** Anomalia media all'epoca [°] */
  M0: number;
  /** Data giuliana dell'epoca (default J2000). */
  epochJD?: number;
  /** Variazioni secolari [°/giorno] (opzionali). */
  nodeRate?: number;
  argpRate?: number;
  /** Moto medio [°/giorno]; se assente viene calcolato da μ e a. */
  meanMotion?: number;
  /** Piano di riferimento: eclittica J2000 o equatore del pianeta. */
  frame: 'ecliptic' | 'parentEquator';
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  parent: string | null;
  /** Parametro gravitazionale GM [m^3/s^2] */
  gm: number;
  /** Raggio medio [m] */
  radius: number;
  /** Colore indicativo per il rendering */
  color: string;
  /** Periodo di rotazione siderale [ore], negativo se retrogrado. */
  rotationPeriod?: number;
  /** Rotazione sincrona (lune in rotazione bloccata). */
  tidallyLocked?: boolean;
  /** Polo nord IAU (ascensione retta, declinazione) [°] ICRF J2000. */
  pole?: { ra: number; dec: number };
  planetElements?: PlanetElements;
  moonElements?: MoonElements;
}

function pe(el: [number, number, number, number, number, number], rates: [number, number, number, number, number, number]): PlanetElements {
  const [a, e, I, L, varpi, node] = el;
  const [aDot, eDot, IDot, LDot, varpiDot, nodeDot] = rates;
  return { a, e, I, L, varpi, node, aDot, eDot, IDot, LDot, varpiDot, nodeDot };
}

function me(a: number, e: number, i: number, node: number, argp: number, M0: number): MoonElements {
  return { a, e, i, node, argp, M0, frame: 'parentEquator' };
}

const gm = (km3s2: number) => km3s2 * KM3S2;
const km = (x: number) => x * KM;

export const SOLAR_SYSTEM: readonly BodyDef[] = [
  // ───────────────────────── Stella ─────────────────────────
  {
    id: 'sun', name: 'Sole', kind: 'star', parent: null,
    gm: gm(1.32712440041279e11), radius: km(695700), color: '#ffd27f',
    rotationPeriod: 609.12, pole: { ra: 286.13, dec: 63.87 },
  },

  // ───────────────────────── Pianeti ─────────────────────────
  {
    id: 'mercury', name: 'Mercurio', kind: 'planet', parent: 'sun',
    gm: gm(22031.868551), radius: km(2439.7), color: '#a8a8a8',
    rotationPeriod: 1407.6, pole: { ra: 281.0103, dec: 61.4155 },
    planetElements: pe(
      [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
      [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]),
  },
  {
    id: 'venus', name: 'Venere', kind: 'planet', parent: 'sun',
    gm: gm(324858.592), radius: km(6051.8), color: '#e8cda2',
    rotationPeriod: -5832.6, pole: { ra: 272.76, dec: 67.16 },
    planetElements: pe(
      [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
      [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418]),
  },
  {
    id: 'earth', name: 'Terra', kind: 'planet', parent: 'sun',
    gm: gm(398600.435507), radius: km(6371.0), color: '#4f8fe6',
    rotationPeriod: 23.9345, pole: { ra: 0, dec: 90 },
    // Baricentro Terra–Luna
    planetElements: pe(
      [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
      [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]),
  },
  {
    id: 'mars', name: 'Marte', kind: 'planet', parent: 'sun',
    gm: gm(42828.375214), radius: km(3389.5), color: '#d0643a',
    rotationPeriod: 24.6229, pole: { ra: 317.269, dec: 54.433 },
    planetElements: pe(
      [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
      [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]),
  },
  {
    id: 'jupiter', name: 'Giove', kind: 'planet', parent: 'sun',
    gm: gm(126686531.9), radius: km(69911), color: '#d9b38c',
    rotationPeriod: 9.925, pole: { ra: 268.057, dec: 64.495 },
    planetElements: pe(
      [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
      [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]),
  },
  {
    id: 'saturn', name: 'Saturno', kind: 'planet', parent: 'sun',
    gm: gm(37931206.23), radius: km(58232), color: '#e3cf98',
    rotationPeriod: 10.656, pole: { ra: 40.589, dec: 83.537 },
    planetElements: pe(
      [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
      [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]),
  },
  {
    id: 'uranus', name: 'Urano', kind: 'planet', parent: 'sun',
    gm: gm(5793951.3), radius: km(25362), color: '#9fe3e8',
    rotationPeriod: -17.24, pole: { ra: 257.311, dec: -15.175 },
    planetElements: pe(
      [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
      [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]),
  },
  {
    id: 'neptune', name: 'Nettuno', kind: 'planet', parent: 'sun',
    gm: gm(6835099.5), radius: km(24622), color: '#4a6fe3',
    rotationPeriod: 16.11, pole: { ra: 299.36, dec: 43.46 },
    planetElements: pe(
      [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
      [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]),
  },
  {
    id: 'pluto', name: 'Plutone', kind: 'dwarf', parent: 'sun',
    gm: gm(869.3), radius: km(1188.3), color: '#d6b89a',
    rotationPeriod: -153.29, pole: { ra: 132.993, dec: -6.163 },
    planetElements: pe(
      [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
      [-0.00031596, 0.0000517, 0.00004818, 145.20780515, -0.04062942, -0.01183482]),
  },

  // ───────────────────────── Lune ─────────────────────────
  {
    id: 'moon', name: 'Luna', kind: 'moon', parent: 'earth',
    gm: gm(4902.800118), radius: km(1737.4), color: '#c8c8c8', tidallyLocked: true,
    moonElements: {
      a: 384400, e: 0.0549, i: 5.1454, node: 125.1228, argp: 318.0634, M0: 115.3654,
      epochJD: 2451543.5, nodeRate: -0.0529538083, argpRate: 0.1643573223, meanMotion: 13.0649929509,
      frame: 'ecliptic',
    },
  },
  {
    id: 'phobos', name: 'Phobos', kind: 'moon', parent: 'mars',
    gm: gm(7.087546e-4), radius: km(11.08), color: '#8a7f75', tidallyLocked: true,
    moonElements: me(9376, 0.0151, 1.075, 207.784, 150.057, 91.059),
  },
  {
    id: 'deimos', name: 'Deimos', kind: 'moon', parent: 'mars',
    gm: gm(9.615569e-5), radius: km(6.27), color: '#a39a8e', tidallyLocked: true,
    moonElements: me(23458, 0.0002, 1.788, 24.525, 260.729, 325.329),
  },
  {
    id: 'io', name: 'Io', kind: 'moon', parent: 'jupiter',
    gm: gm(5959.916), radius: km(1821.6), color: '#e8d35a', tidallyLocked: true,
    moonElements: me(421800, 0.0041, 0.036, 43.977, 84.129, 342.021),
  },
  {
    id: 'europa', name: 'Europa', kind: 'moon', parent: 'jupiter',
    gm: gm(3202.739), radius: km(1560.8), color: '#d8cfb8', tidallyLocked: true,
    moonElements: me(671100, 0.0094, 0.466, 219.106, 88.97, 171.016),
  },
  {
    id: 'ganymede', name: 'Ganimede', kind: 'moon', parent: 'jupiter',
    gm: gm(9887.834), radius: km(2634.1), color: '#9c9082', tidallyLocked: true,
    moonElements: me(1070400, 0.0013, 0.177, 63.552, 192.417, 317.54),
  },
  {
    id: 'callisto', name: 'Callisto', kind: 'moon', parent: 'jupiter',
    gm: gm(7179.289), radius: km(2410.3), color: '#6e655b', tidallyLocked: true,
    moonElements: me(1882700, 0.0074, 0.192, 298.848, 52.643, 181.408),
  },
  {
    id: 'titan', name: 'Titano', kind: 'moon', parent: 'saturn',
    gm: gm(8978.1382), radius: km(2574.7), color: '#d9a441', tidallyLocked: true,
    moonElements: me(1221870, 0.0288, 0.306, 28.06, 180.532, 163.31),
  },
  {
    id: 'titania', name: 'Titania', kind: 'moon', parent: 'uranus',
    gm: gm(228.2), radius: km(788.4), color: '#b8b1a8', tidallyLocked: true,
    moonElements: me(436300, 0.0011, 0.079, 99.771, 284.4, 24.614),
  },
  {
    id: 'oberon', name: 'Oberon', kind: 'moon', parent: 'uranus',
    gm: gm(192.4), radius: km(761.4), color: '#9e948a', tidallyLocked: true,
    moonElements: me(583500, 0.0014, 0.068, 279.771, 104.4, 283.088),
  },
  {
    id: 'triton', name: 'Tritone', kind: 'moon', parent: 'neptune',
    gm: gm(1427.598), radius: km(1353.4), color: '#d8c8c0', tidallyLocked: true,
    // Orbita retrograda (i > 90°)
    moonElements: me(354759, 0.00002, 156.865, 177.608, 0, 264.775),
  },
  {
    id: 'charon', name: 'Caronte', kind: 'moon', parent: 'pluto',
    gm: gm(105.88), radius: km(606.0), color: '#9c948c', tidallyLocked: true,
    moonElements: me(19591, 0.0002, 0.08, 0, 0, 0),
  },
];

export function findBody(catalog: readonly BodyDef[], id: string): BodyDef | undefined {
  return catalog.find((b) => b.id === id);
}
