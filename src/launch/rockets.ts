/**
 * Lanciatori reali (valori pubblici approssimati, tutti modificabili dall'interfaccia).
 * Masse in kg, spinte in N, impulsi specifici in s.
 *
 * Convenzione degli stadi: elencati nell'ordine di accensione. Uno stadio con `parallel: true`
 * (booster laterali) si accende insieme al primo stadio "centrale" che lo segue e si separa
 * quando esaurisce il propellente.
 */

export interface StageDef {
  name: string;
  /** Unità identiche (es. 2 booster laterali). Masse e spinte sono PER UNITÀ. */
  count: number;
  dryMass: number;
  propMass: number;
  thrustSL: number;
  thrustVac: number;
  ispSL: number;
  ispVac: number;
  parallel?: boolean;
  /** Spinta minima regolabile (0–1). 1 = non regolabile (es. propellente solido). */
  minThrottle: number;
  /** Regolazione mentre i booster laterali sono agganciati (es. core del Falcon Heavy). */
  throttleWithBoosters?: number;
  /** Stadio recuperabile: con il recupero attivo conserva una riserva di propellente. */
  recoverable?: boolean;
  /** Propellente solido: non si spegne a comando e non si riaccende. */
  solid?: boolean;
}

export interface RocketDef {
  id: string;
  name: string;
  maker: string;
  stages: StageDef[];
  /** Ogiva / torre di salvataggio, espulsa sopra ~110 km. */
  fairingMass: number;
  /** Diametro equivalente per l'area di riferimento aerodinamica [m]. */
  diameter: number;
  /** Coefficiente di resistenza base (subsonico). */
  cd: number;
  /** Prestazioni dichiarate dal costruttore, per confronto [kg]. */
  reference: string;
  defaultPayload: number;
  note: string;
}

const kN = 1e3;

export const ROCKETS: RocketDef[] = [
  {
    id: 'falcon9', name: 'Falcon 9 Block 5', maker: 'SpaceX (USA)',
    stages: [
      { name: 'Primo stadio (9 × Merlin 1D)', count: 1, dryMass: 25600, propMass: 395700, thrustSL: 7607 * kN, thrustVac: 8227 * kN, ispSL: 283, ispVac: 312, minThrottle: 0.57, recoverable: true },
      { name: 'Secondo stadio (Merlin Vacuum)', count: 1, dryMass: 4000, propMass: 92670, thrustSL: 600 * kN, thrustVac: 981 * kN, ispSL: 200, ispVac: 348, minThrottle: 0.39 },
    ],
    fairingMass: 1900, diameter: 3.7, cd: 0.3,
    reference: 'LEO 22.800 kg (senza recupero) · GTO 8.300 kg · Marte 4.020 kg',
    defaultPayload: 15000,
    note: 'Il lanciatore più usato al mondo. Con il recupero del primo stadio la capacità cala di circa il 30%.',
  },
  {
    id: 'falconheavy', name: 'Falcon Heavy', maker: 'SpaceX (USA)',
    stages: [
      { name: 'Booster laterali (2 × 9 Merlin)', count: 2, dryMass: 25600, propMass: 395700, thrustSL: 7607 * kN, thrustVac: 8227 * kN, ispSL: 283, ispVac: 312, parallel: true, minThrottle: 0.57, recoverable: true },
      { name: 'Core centrale (9 Merlin)', count: 1, dryMass: 30000, propMass: 395700, thrustSL: 7607 * kN, thrustVac: 8227 * kN, ispSL: 283, ispVac: 312, minThrottle: 0.57, throttleWithBoosters: 0.6, recoverable: true },
      { name: 'Secondo stadio (Merlin Vacuum)', count: 1, dryMass: 4000, propMass: 92670, thrustSL: 600 * kN, thrustVac: 981 * kN, ispSL: 200, ispVac: 348, minThrottle: 0.39 },
    ],
    fairingMass: 1900, diameter: 6.3, cd: 0.33,
    reference: 'LEO 63.800 kg · GTO 26.700 kg · Marte 16.800 kg (senza recupero)',
    defaultPayload: 20000,
    note: 'Tre primi stadi di Falcon 9 affiancati; il core centrale riduce la spinta finché ci sono i booster.',
  },
  {
    id: 'atlas551', name: 'Atlas V 551', maker: 'United Launch Alliance (USA)',
    stages: [
      { name: '5 booster a propellente solido AJ-60A', count: 5, dryMass: 5740, propMass: 42630, thrustSL: 1150 * kN, thrustVac: 1270 * kN, ispSL: 248, ispVac: 279, parallel: true, minThrottle: 1, solid: true },
      { name: 'Common Core Booster (RD-180)', count: 1, dryMass: 21054, propMass: 284089, thrustSL: 3827 * kN, thrustVac: 4152 * kN, ispSL: 311, ispVac: 338, minThrottle: 0.47 },
      { name: 'Centaur (RL10)', count: 1, dryMass: 2316, propMass: 20830, thrustSL: 40 * kN, thrustVac: 101.8 * kN, ispSL: 200, ispVac: 450.5, minThrottle: 1 },
    ],
    fairingMass: 4000, diameter: 5.4, cd: 0.33,
    reference: 'LEO 18.850 kg · GTO 8.900 kg — ha lanciato New Horizons e Juno',
    defaultPayload: 4000,
    note: 'Lo stadio Centaur a idrogeno è ideale per le missioni interplanetarie.',
  },
  {
    id: 'ariane64', name: 'Ariane 64', maker: 'ArianeGroup / ESA (Europa)',
    stages: [
      { name: '4 booster P120C', count: 4, dryMass: 11000, propMass: 142000, thrustSL: 2700 * kN, thrustVac: 3000 * kN, ispSL: 250, ispVac: 279, parallel: true, minThrottle: 1, solid: true },
      { name: 'Stadio centrale LLPM (Vulcain 2.1)', count: 1, dryMass: 16000, propMass: 150000, thrustSL: 960 * kN, thrustVac: 1370 * kN, ispSL: 318, ispVac: 431, minThrottle: 1 },
      { name: 'Stadio superiore ULPM (Vinci)', count: 1, dryMass: 5000, propMass: 31000, thrustSL: 80 * kN, thrustVac: 180 * kN, ispSL: 250, ispVac: 457, minThrottle: 1 },
    ],
    fairingMass: 2600, diameter: 8.8, cd: 0.33,
    reference: 'LEO 21.650 kg · GTO 11.500 kg',
    defaultPayload: 10000,
    note: 'Il motore Vinci è riaccendibile: adatto a costellazioni e missioni con più accensioni.',
  },
  {
    id: 'vegac', name: 'Vega-C', maker: 'Avio / ESA (Italia)',
    stages: [
      { name: 'P120C', count: 1, dryMass: 11000, propMass: 142000, thrustSL: 2700 * kN, thrustVac: 3000 * kN, ispSL: 250, ispVac: 279, minThrottle: 1, solid: true },
      { name: 'Zefiro 40', count: 1, dryMass: 3600, propMass: 36200, thrustSL: 800 * kN, thrustVac: 1100 * kN, ispSL: 230, ispVac: 293.5, minThrottle: 1, solid: true },
      { name: 'Zefiro 9', count: 1, dryMass: 1315, propMass: 10567, thrustSL: 200 * kN, thrustVac: 317 * kN, ispSL: 200, ispVac: 295.9, minThrottle: 1, solid: true },
      { name: 'AVUM+', count: 1, dryMass: 700, propMass: 740, thrustSL: 1.5 * kN, thrustVac: 2.45 * kN, ispSL: 200, ispVac: 315.5, minThrottle: 1 },
    ],
    fairingMass: 860, diameter: 3.4, cd: 0.3,
    reference: 'SSO 700 km: 2.300 kg · LEO: 3.300 kg',
    defaultPayload: 1500,
    note: 'Costruito in Italia (Colleferro): tre stadi solidi e lo stadio AVUM+ a liquido.',
  },
  {
    id: 'electron', name: 'Electron', maker: 'Rocket Lab (USA/Nuova Zelanda)',
    stages: [
      { name: 'Primo stadio (9 × Rutherford)', count: 1, dryMass: 950, propMass: 9250, thrustSL: 192 * kN, thrustVac: 224 * kN, ispSL: 303, ispVac: 311, minThrottle: 1, recoverable: true },
      { name: 'Secondo stadio (Rutherford Vacuum)', count: 1, dryMass: 250, propMass: 2150, thrustSL: 15 * kN, thrustVac: 25.8 * kN, ispSL: 250, ispVac: 343, minThrottle: 1 },
    ],
    fairingMass: 50, diameter: 1.2, cd: 0.3,
    reference: 'LEO 300 kg · SSO 500 km: 200 kg',
    defaultPayload: 200,
    note: 'Piccolo lanciatore con motori a pompe elettriche.',
  },
  {
    id: 'sls1', name: 'SLS Block 1', maker: 'NASA / Boeing (USA)',
    stages: [
      { name: '2 booster solidi a 5 segmenti', count: 2, dryMass: 98000, propMass: 628000, thrustSL: 11800 * kN, thrustVac: 13000 * kN, ispSL: 242, ispVac: 269, parallel: true, minThrottle: 1, solid: true },
      { name: 'Core Stage (4 × RS-25)', count: 1, dryMass: 85270, propMass: 987470, thrustSL: 7440 * kN, thrustVac: 9116 * kN, ispSL: 366, ispVac: 452, minThrottle: 0.67 },
      { name: 'ICPS (RL10B-2)', count: 1, dryMass: 3490, propMass: 28900, thrustSL: 40 * kN, thrustVac: 110 * kN, ispSL: 200, ispVac: 465.5, minThrottle: 1 },
    ],
    fairingMass: 7600, diameter: 9.9, cd: 0.33,
    reference: 'Iniezione translunare: 27.000 kg (Orion, missioni Artemis)',
    defaultPayload: 26500,
    note: 'Il “fairing” rappresenta la torre di salvataggio di Orion, espulsa in salita.',
  },
  {
    id: 'saturnv', name: 'Saturn V', maker: 'NASA (USA, 1967–1973)',
    stages: [
      { name: 'S-IC (5 × F-1)', count: 1, dryMass: 131000, propMass: 2149000, thrustSL: 34020 * kN, thrustVac: 38700 * kN, ispSL: 263, ispVac: 304, minThrottle: 1 },
      { name: 'S-II (5 × J-2)', count: 1, dryMass: 40100, propMass: 443000, thrustSL: 3000 * kN, thrustVac: 5165 * kN, ispSL: 200, ispVac: 421, minThrottle: 1 },
      { name: 'S-IVB (J-2)', count: 1, dryMass: 13500, propMass: 107100, thrustSL: 600 * kN, thrustVac: 1033 * kN, ispSL: 200, ispVac: 421, minThrottle: 1 },
    ],
    fairingMass: 4200, diameter: 10.1, cd: 0.3,
    reference: 'LEO 140.000 kg · iniezione translunare 48.600 kg (Apollo 15–17)',
    defaultPayload: 45000,
    note: 'Il “fairing” è la torre di salvataggio (LES). Il carico è il complesso Apollo CSM + LM.',
  },
  {
    id: 'starship', name: 'Starship (Block 2, indicativo)', maker: 'SpaceX (USA)',
    stages: [
      { name: 'Super Heavy (33 × Raptor)', count: 1, dryMass: 200000, propMass: 3400000, thrustSL: 74400 * kN, thrustVac: 81000 * kN, ispSL: 327, ispVac: 350, minThrottle: 0.4, recoverable: true },
      { name: 'Ship (3 Raptor + 3 Raptor Vacuum)', count: 1, dryMass: 100000, propMass: 1500000, thrustSL: 7000 * kN, thrustVac: 15000 * kN, ispSL: 300, ispVac: 365, minThrottle: 0.4 },
    ],
    fairingMass: 0, diameter: 9, cd: 0.35,
    reference: 'Obiettivo: oltre 100.000 kg in LEO (veicolo in sviluppo, valori indicativi)',
    defaultPayload: 50000,
    note: 'Valori in evoluzione: usali come punto di partenza da modificare.',
  },
];

export function cloneRocket(r: RocketDef): RocketDef {
  return JSON.parse(JSON.stringify(r)) as RocketDef;
}

/** Siti di lancio reali (latitudine/longitudine geodetiche in gradi). */
export interface LaunchSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  alt: number;
}

export const SITES: LaunchSite[] = [
  { id: 'ksc39a', name: 'Kennedy Space Center LC-39A (Florida)', lat: 28.6083, lon: -80.6041, alt: 30 },
  { id: 'ccsfs41', name: 'Cape Canaveral SLC-41 (Florida)', lat: 28.5833, lon: -80.5829, alt: 20 },
  { id: 'vsfb4e', name: 'Vandenberg SLC-4E (California)', lat: 34.6321, lon: -120.6107, alt: 120 },
  { id: 'kourou', name: 'Guiana Space Centre ELA-4 (Kourou)', lat: 5.2644, lon: -52.7917, alt: 20 },
  { id: 'starbase', name: 'Starbase (Texas)', lat: 25.9967, lon: -97.1541, alt: 5 },
  { id: 'baikonur', name: 'Baikonur, Gagarin\'s Start (Kazakistan)', lat: 45.9203, lon: 63.3421, alt: 90 },
  { id: 'wenchang', name: 'Wenchang LC-101 (Cina)', lat: 19.6144, lon: 110.9511, alt: 10 },
  { id: 'jiuquan', name: 'Jiuquan (Cina)', lat: 40.958, lon: 100.291, alt: 1000 },
  { id: 'tanegashima', name: 'Tanegashima (Giappone)', lat: 30.4009, lon: 130.9749, alt: 20 },
  { id: 'sriharikota', name: 'Satish Dhawan, Sriharikota (India)', lat: 13.7199, lon: 80.2304, alt: 10 },
  { id: 'mahia', name: 'Rocket Lab LC-1, Mahia (Nuova Zelanda)', lat: -39.2622, lon: 177.8649, alt: 30 },
  { id: 'andoya', name: 'Andøya Spaceport (Norvegia)', lat: 69.294, lon: 16.02, alt: 20 },
];
