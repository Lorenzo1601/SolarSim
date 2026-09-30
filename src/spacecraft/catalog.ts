/**
 * Catalogo degli oggetti artificiali.
 *
 * Due fonti di dati reali:
 *  - 'tle'      → elementi orbitali GP/TLE aggiornati di CelesTrak (dati NORAD / U.S. Space Force),
 *                 propagati con SGP4. Per satelliti in orbita terrestre.
 *  - 'horizons' → effemeridi ufficiali JPL Horizons (sonde interplanetarie, punti lagrangiani,
 *                 orbiter di Luna, Marte e Giove).
 * In più, per le sonde del Deep Space Network, lo stato LIVE dei collegamenti (DSN Now).
 */

export type ArtificialCategory =
  | 'station'
  | 'telescope'
  | 'lagrange'
  | 'earth'
  | 'deep'
  | 'planetary'
  | 'historic'
  | 'asteroid'
  | 'tno';

export const CATEGORY_INFO: Record<ArtificialCategory, { label: string; color: string }> = {
  station: { label: 'Stazioni spaziali', color: '#ffffff' },
  telescope: { label: 'Telescopi in orbita terrestre', color: '#c89bff' },
  lagrange: { label: 'Osservatori nei punti lagrangiani', color: '#ff9bd6' },
  earth: { label: 'Osservazione della Terra e meteo', color: '#7fe0a0' },
  deep: { label: 'Sonde interplanetarie', color: '#ffb35c' },
  planetary: { label: 'Orbiter di Luna, Marte e Giove', color: '#ffd84d' },
  historic: { label: 'Storici', color: '#9fb4cc' },
  asteroid: { label: 'Asteroidi', color: '#d9b48c' },
  tno: { label: 'Pianeti nani e oggetti transnettuniani', color: '#8fb3d9' },
};

/** Corpi del motore fisico attorno ai quali può essere riferito un oggetto artificiale. */
export type CenterId = 'sun' | 'earth' | 'moon' | 'mars' | 'jupiter';

export type ArtificialSource =
  | { type: 'tle'; norad: number }
  | {
      type: 'horizons';
      /** Id NAIF/Horizons (es. '-31' per Voyager 1). */
      command: string;
      /** Passo della tabella (es. '1 d', '6 h', '10 m'). */
      step: string;
      /** Semi-ampiezza della finestra tabulata [giorni]. */
      halfSpan: number;
      /**
       * Traiettoria storica (solo sonde eliocentriche): true = dal lancio,
       * numero = solo gli ultimi N giorni (per chi compie molte orbite attorno al Sole).
       */
      history?: boolean | number;
    };

export interface ArtificialDef {
  id: string;
  name: string;
  category: ArtificialCategory;
  /** Etichetta di categoria alternativa (es. satelliti presi da un catalogo). */
  categoryLabel?: string;
  center: CenterId;
  source: ArtificialSource;
  operator: string;
  /** Data di lancio (ISO). */
  launch: string;
  note: string;
  /** Visibile alla prima apertura. */
  defaultVisible?: boolean;
  /** Corpo naturale (asteroide): identificativo per i dati fisici del JPL Small-Body Database. */
  sbdb?: string;
  /** Satellite in orbita terrestre: id JPL Horizons per l'archivio storico (se diverso dalla regola −(100000+NORAD)). */
  archive?: string;
}

const tle = (norad: number): ArtificialSource => ({ type: 'tle', norad });
const hz = (command: string, step: string, halfSpan: number, history: boolean | number = false): ArtificialSource => ({
  type: 'horizons', command, step, halfSpan, history,
});

export const FEATURED: readonly ArtificialDef[] = [
  // ── Stazioni ──
  { id: 'iss', name: 'ISS', category: 'station', center: 'earth', source: tle(25544), operator: 'NASA · Roscosmos · ESA · JAXA · CSA', launch: '1998-11-20', note: 'Stazione Spaziale Internazionale, abitata continuativamente dal 2000.', defaultVisible: true },
  { id: 'css', name: 'Tiangong (CSS)', category: 'station', center: 'earth', source: tle(48274), operator: 'CMSA (Cina)', launch: '2021-04-29', note: 'Stazione spaziale cinese, modulo centrale Tianhe.', defaultVisible: true },

  // ── Telescopi in orbita terrestre ──
  { id: 'hubble', name: 'Hubble', category: 'telescope', center: 'earth', source: tle(20580), archive: '-48', operator: 'NASA · ESA', launch: '1990-04-24', note: 'Telescopio spaziale ottico/UV in orbita bassa.', defaultVisible: true },
  { id: 'chandra', name: 'Chandra', category: 'telescope', center: 'earth', source: tle(25867), archive: '-151', operator: 'NASA', launch: '1999-07-23', note: 'Osservatorio a raggi X in orbita molto ellittica.' },
  { id: 'xmm', name: 'XMM-Newton', category: 'telescope', center: 'earth', source: tle(25989), operator: 'ESA', launch: '1999-12-10', note: 'Osservatorio a raggi X in orbita molto ellittica.' },
  { id: 'tess', name: 'TESS', category: 'telescope', center: 'earth', source: tle(43435), archive: '-95', operator: 'NASA', launch: '2018-04-18', note: 'Caccia agli esopianeti, orbita in risonanza 2:1 con la Luna.' },
  { id: 'fermi', name: 'Fermi', category: 'telescope', center: 'earth', source: tle(33053), operator: 'NASA', launch: '2008-06-11', note: 'Telescopio a raggi gamma.' },
  { id: 'swift', name: 'Swift', category: 'telescope', center: 'earth', source: tle(28485), operator: 'NASA', launch: '2004-11-20', note: 'Lampi gamma (GRB).' },
  { id: 'nustar', name: 'NuSTAR', category: 'telescope', center: 'earth', source: tle(38358), operator: 'NASA', launch: '2012-06-13', note: 'Raggi X duri.' },
  { id: 'ixpe', name: 'IXPE', category: 'telescope', center: 'earth', source: tle(49954), operator: 'NASA · ASI', launch: '2021-12-09', note: 'Polarimetria X.' },
  { id: 'xrism', name: 'XRISM', category: 'telescope', center: 'earth', source: tle(57800), operator: 'JAXA · NASA', launch: '2023-09-06', note: 'Spettroscopia X ad alta risoluzione.' },

  // ── Punti lagrangiani (Horizons, riferiti alla Terra) ──
  { id: 'jwst', name: 'James Webb (JWST)', category: 'lagrange', center: 'earth', source: hz('-170', '1 d', 60), operator: 'NASA · ESA · CSA', launch: '2021-12-25', note: 'Orbita di alone attorno al punto L2 Sole–Terra, ~1,5 milioni di km.', defaultVisible: true },
  { id: 'euclid', name: 'Euclid', category: 'lagrange', center: 'earth', source: hz('-680', '1 d', 60), operator: 'ESA', launch: '2023-07-01', note: 'Materia ed energia oscura, orbita attorno a L2.' },
  { id: 'soho', name: 'SOHO', category: 'lagrange', center: 'earth', source: hz('-21', '1 d', 60), operator: 'ESA · NASA', launch: '1995-12-02', note: 'Osservatorio solare in orbita attorno a L1.' },

  // ── Osservazione della Terra e meteo ──
  { id: 'landsat9', name: 'Landsat 9', category: 'earth', center: 'earth', source: tle(49260), operator: 'NASA · USGS', launch: '2021-09-27', note: 'Orbita eliosincrona.' },
  { id: 'landsat8', name: 'Landsat 8', category: 'earth', center: 'earth', source: tle(39084), operator: 'NASA · USGS', launch: '2013-02-11', note: 'Orbita eliosincrona.' },
  { id: 'terra', name: 'Terra', category: 'earth', center: 'earth', source: tle(25994), operator: 'NASA', launch: '1999-12-18', note: 'Ammiraglia del sistema EOS.' },
  { id: 'aqua', name: 'Aqua', category: 'earth', center: 'earth', source: tle(27424), operator: 'NASA', launch: '2002-05-04', note: 'Ciclo dell\'acqua (EOS).' },
  { id: 'noaa20', name: 'NOAA-20', category: 'earth', center: 'earth', source: tle(43013), operator: 'NOAA · NASA', launch: '2017-11-18', note: 'Meteo polare (JPSS-1).' },
  { id: 'goes19', name: 'GOES-19', category: 'earth', center: 'earth', source: tle(60133), operator: 'NOAA', launch: '2024-06-25', note: 'Meteo geostazionario (GOES-East).' },
  { id: 'goes16', name: 'GOES-16', category: 'earth', center: 'earth', source: tle(41866), operator: 'NOAA', launch: '2016-11-19', note: 'Meteo geostazionario.' },

  // ── Sonde interplanetarie (Horizons, eliocentriche) ──
  { id: 'voyager1', name: 'Voyager 1', category: 'deep', center: 'sun', source: hz('-31', '1 d', 20, true), operator: 'NASA / JPL', launch: '1977-09-05', note: 'Nello spazio interstellare dal 2012: l\'oggetto umano più lontano.', defaultVisible: true },
  { id: 'voyager2', name: 'Voyager 2', category: 'deep', center: 'sun', source: hz('-32', '1 d', 20, true), operator: 'NASA / JPL', launch: '1977-08-20', note: 'Unica sonda ad aver visitato Urano e Nettuno; interstellare dal 2018.', defaultVisible: true },
  { id: 'newhorizons', name: 'New Horizons', category: 'deep', center: 'sun', source: hz('-98', '1 d', 20, true), operator: 'NASA / JHUAPL', launch: '2006-01-19', note: 'Flyby di Plutone (2015) e di Arrokoth (2019), ora nella fascia di Kuiper.', defaultVisible: true },
  { id: 'parker', name: 'Parker Solar Probe', category: 'deep', center: 'sun', source: hz('-96', '6 h', 10, 400), operator: 'NASA / JHUAPL', launch: '2018-08-12', note: 'L\'oggetto più veloce mai costruito: perielio a ~6,2 milioni di km dal Sole.', defaultVisible: true },
  { id: 'solo', name: 'Solar Orbiter', category: 'deep', center: 'sun', source: hz('-144', '6 h', 10, 400), operator: 'ESA · NASA', launch: '2020-02-10', note: 'Osserva i poli del Sole da orbite inclinate.' },
  { id: 'europaclipper', name: 'Europa Clipper', category: 'deep', center: 'sun', source: hz('-159', '1 d', 20, true), operator: 'NASA / JPL', launch: '2024-10-14', note: 'In viaggio verso Giove (arrivo previsto 2030).', defaultVisible: true },
  { id: 'juice', name: 'JUICE', category: 'deep', center: 'sun', source: hz('-28', '1 d', 20, true), operator: 'ESA', launch: '2023-04-14', note: 'In viaggio verso le lune ghiacciate di Giove (arrivo 2031).', defaultVisible: true },
  { id: 'bepicolombo', name: 'BepiColombo', category: 'deep', center: 'sun', source: hz('-121', '6 h', 10, 400), operator: 'ESA · JAXA', launch: '2018-10-20', note: 'Missione verso Mercurio.' },
  { id: 'lucy', name: 'Lucy', category: 'deep', center: 'sun', source: hz('-49', '1 d', 20, true), operator: 'NASA', launch: '2021-10-16', note: 'Verso gli asteroidi troiani di Giove.' },
  { id: 'psyche', name: 'Psyche', category: 'deep', center: 'sun', source: hz('-255', '1 d', 20, true), operator: 'NASA / JPL', launch: '2023-10-13', note: 'Verso l\'asteroide metallico 16 Psyche (arrivo 2029).' },
  { id: 'hera', name: 'Hera', category: 'deep', center: 'sun', source: hz('-91', '1 d', 20, true), operator: 'ESA', launch: '2024-10-07', note: 'Verso il sistema binario Didymos–Dimorphos (dopo DART).' },
  { id: 'osirisapex', name: 'OSIRIS-APEX', category: 'deep', center: 'sun', source: hz('-64', '1 d', 20, 400), operator: 'NASA', launch: '2016-09-08', note: 'Ex OSIRIS-REx, diretta verso Apophis (2029).' },
  { id: 'hayabusa2', name: 'Hayabusa2', category: 'deep', center: 'sun', source: hz('-37', '1 d', 20, 400), operator: 'JAXA', launch: '2014-12-03', note: 'Missione estesa verso l\'asteroide 1998 KY26.' },
  { id: 'stereoa', name: 'STEREO-A', category: 'deep', center: 'sun', source: hz('-234', '1 d', 20, 400), operator: 'NASA', launch: '2006-10-26', note: 'Osservatorio solare in orbita eliocentrica.' },
  { id: 'gaia', name: 'Gaia', category: 'deep', center: 'sun', source: hz('-139479', '1 d', 20), operator: 'ESA', launch: '2013-12-19', note: 'Missione conclusa nel 2025, spostata in orbita eliocentrica e disattivata.' },

  // ── Orbiter planetari (Horizons, riferiti al pianeta) ──
  { id: 'juno', name: 'Juno', category: 'planetary', center: 'jupiter', source: hz('-61', '2 h', 5), operator: 'NASA / JPL', launch: '2011-08-05', note: 'In orbita polare attorno a Giove dal 2016.' },
  { id: 'mro', name: 'Mars Reconnaissance Orbiter', category: 'planetary', center: 'mars', source: hz('-74', '10 m', 0.5), operator: 'NASA / JPL', launch: '2005-08-12', note: 'Orbita bassa marziana, fotocamera HiRISE.' },
  { id: 'marsexpress', name: 'Mars Express', category: 'planetary', center: 'mars', source: hz('-41', '20 m', 1), operator: 'ESA', launch: '2003-06-02', note: 'Orbita polare ellittica attorno a Marte.' },
  { id: 'tgo', name: 'ExoMars TGO', category: 'planetary', center: 'mars', source: hz('-143', '10 m', 0.5), operator: 'ESA · Roscosmos', launch: '2016-03-14', note: 'Trace Gas Orbiter.' },
  { id: 'odyssey', name: 'Mars Odyssey', category: 'planetary', center: 'mars', source: hz('-53', '10 m', 0.5), operator: 'NASA / JPL', launch: '2001-04-07', note: 'La sonda marziana più longeva.' },
  { id: 'hope', name: 'Hope (EMM)', category: 'planetary', center: 'mars', source: hz('-62', '1 h', 3), operator: 'MBRSC (EAU)', launch: '2020-07-19', note: 'Atmosfera marziana da orbita alta.' },
  { id: 'lro', name: 'Lunar Reconnaissance Orbiter', category: 'planetary', center: 'moon', source: hz('-85', '5 m', 0.25), operator: 'NASA', launch: '2009-06-18', note: 'Mappatura della Luna.' },
  { id: 'danuri', name: 'Danuri (KPLO)', category: 'planetary', center: 'moon', source: hz('-155', '5 m', 0.25), operator: 'KARI (Corea del Sud)', launch: '2022-08-04', note: 'Orbiter lunare coreano.' },
  { id: 'chandrayaan2', name: 'Chandrayaan-2', category: 'planetary', center: 'moon', source: hz('-152', '5 m', 0.25), operator: 'ISRO (India)', launch: '2019-07-22', note: 'Orbiter lunare indiano.' },

  // ── Asteroidi (effemeridi JPL Horizons; dati fisici JPL SBDB) ──
  ...[
    ['ceres', 'Cerere', '1', '4 d', 90, 'Il più grande corpo della fascia principale, pianeta nano. Visitato da Dawn (2015–2018).', true],
    ['pallas', 'Pallade', '2', '4 d', 90, 'Secondo asteroide scoperto (1802), orbita molto inclinata.', false],
    ['vesta', 'Vesta', '4', '4 d', 90, 'Asteroide differenziato, esplorato da Dawn (2011–2012).', true],
    ['hygiea', 'Igea', '10', '4 d', 90, 'Quarto asteroide per dimensioni, quasi sferico.', false],
    ['psyche16', '16 Psyche', '16', '4 d', 90, 'Asteroide metallico, obiettivo della missione Psyche.', false],
    ['lutetia', 'Lutezia', '21', '4 d', 90, 'Sorvolato da Rosetta nel 2010.', false],
    ['ida', 'Ida', '243', '4 d', 90, 'Primo asteroide con una luna scoperta (Dattilo), da Galileo nel 1993.', false],
    ['eros', 'Eros', '433', '2 d', 60, 'Primo asteroide orbitato e su cui è atterrata una sonda (NEAR Shoemaker, 2001).', false],
    ['phaethon', 'Fetonte', '3200', '1 d', 40, 'Origine dello sciame meteorico delle Geminidi.', false],
    ['toutatis', 'Toutatis', '4179', '2 d', 60, 'Asteroide potenzialmente pericoloso dalla forma allungata.', false],
    ['itokawa', 'Itokawa', '25143', '2 d', 60, 'Campioni riportati a Terra da Hayabusa (2010).', false],
    ['bennu', 'Bennu', '101955', '1 d', 40, 'Campioni riportati a Terra da OSIRIS-REx (2023).', false],
    ['ryugu', 'Ryugu', '162173', '1 d', 40, 'Campioni riportati a Terra da Hayabusa2 (2020).', false],
    ['apophis', 'Apophis', '99942', '1 d', 30, 'Passerà a ~32.000 km dalla Terra il 13 aprile 2029.', true],
    ['didymos', 'Didymos', '65803', '1 d', 40, 'Sistema doppio: la luna Dimorphos è stata colpita da DART (2022).', false],
    ['donaldjohanson', 'Donaldjohanson', '52246', '4 d', 90, 'Sorvolato da Lucy nel 2025.', false],
    ['eurybates', 'Eurybates', '3548', '4 d', 90, 'Troiano di Giove, obiettivo di Lucy (2027).', false],
    ['patroclus', 'Patroclo', '617', '4 d', 90, 'Troiano binario, obiettivo di Lucy (2033).', false],
    ['hektor', 'Ettore', '624', '4 d', 90, 'Il più grande troiano di Giove.', false],
    ['leucus', 'Leucus', '11351', '4 d', 90, 'Troiano di Giove, obiettivo di Lucy (2028).', false],
    ['kamooalewa', 'Kamoʻoalewa', '469219', '1 d', 30, 'Quasi-satellite della Terra, forse un frammento della Luna.', false],
    ['yr4', '2024 YR4', 'DES=2024 YR4;', '1 d', 30, 'Per alcune settimane nel 2025 ha avuto la probabilità d\'impatto più alta mai registrata per un oggetto di queste dimensioni.', false],
  ].map(([id, name, num, step, half, note, vis]): ArtificialDef => ({
    id: id as string, name: name as string, category: 'asteroid', center: 'sun',
    source: hz((num as string).includes(';') ? (num as string) : `${num};`, step as string, half as number),
    operator: 'corpo naturale', launch: '', note: note as string, defaultVisible: vis as boolean,
    sbdb: (num as string).startsWith('DES=') ? '2024 YR4' : (num as string),
  })),
  ...[
    ['eris', 'Eris', '136199', 'Pianeta nano più massiccio di Plutone, a ~96 AU.'],
    ['haumea', 'Haumea', '136108', 'Pianeta nano ellissoidale in rapidissima rotazione, con anelli.'],
    ['makemake', 'Makemake', '136472', 'Pianeta nano della fascia di Kuiper.'],
    ['sedna', 'Sedna', '90377', 'Oggetto distaccato con perielio a ~76 AU e afelio a ~900 AU.'],
    ['arrokoth', 'Arrokoth', '486958', 'Oggetto della fascia di Kuiper sorvolato da New Horizons nel 2019.'],
  ].map(([id, name, num, note]): ArtificialDef => ({
    id, name, category: 'tno', center: 'sun', source: hz(`${num};`, '20 d', 400),
    operator: 'corpo naturale', launch: '', note, sbdb: num,
  })),

  // ── Storici ──
  { id: 'vanguard1', name: 'Vanguard 1', category: 'historic', center: 'earth', source: tle(5), operator: 'U.S. Navy', launch: '1958-03-17', note: 'Il più antico oggetto artificiale ancora in orbita.' },
  { id: 'pioneer10', name: 'Pioneer 10', category: 'historic', center: 'sun', source: hz('-23', '1 d', 20, true), operator: 'NASA', launch: '1972-03-03', note: 'Contatto perso nel 2003: posizione calcolata (predetta) dal JPL.' },
  { id: 'pioneer11', name: 'Pioneer 11', category: 'historic', center: 'sun', source: hz('-24', '1 d', 20, true), operator: 'NASA', launch: '1973-04-06', note: 'Contatto perso nel 1995: posizione calcolata (predetta) dal JPL.' },
];

/** Gruppi CelesTrak visualizzati come nuvole di punti. */
export interface SatelliteGroupDef {
  id: string;
  label: string;
  /** Nome del gruppo nell'API GP di CelesTrak. */
  group: string;
  color: string;
}

export const SATELLITE_GROUPS: readonly SatelliteGroupDef[] = [
  { id: 'stations', label: 'Stazioni e moduli', group: 'stations', color: '#ffffff' },
  { id: 'visual', label: 'I 100 più luminosi', group: 'visual', color: '#fff2a8' },
  { id: 'science', label: 'Scientifici', group: 'science', color: '#c89bff' },
  { id: 'weather', label: 'Meteo', group: 'weather', color: '#7fe0a0' },
  { id: 'resource', label: 'Risorse terrestri', group: 'resource', color: '#5cc98a' },
  { id: 'gnss', label: 'Navigazione (GPS, Galileo, GLONASS, BeiDou)', group: 'gnss', color: '#5cc8ff' },
  { id: 'geo', label: 'Geostazionari', group: 'geo', color: '#ff8a5c' },
  { id: 'starlink', label: 'Starlink', group: 'starlink', color: '#8fa3ff' },
  { id: 'oneweb', label: 'OneWeb', group: 'oneweb', color: '#5ce0d2' },
  { id: 'cubesat', label: 'CubeSat', group: 'cubesat', color: '#ffc4e8' },
  { id: 'last30', label: 'Lanciati negli ultimi 30 giorni', group: 'last-30-days', color: '#ffe066' },
  { id: 'active', label: 'Tutti i satelliti attivi', group: 'active', color: '#9ab8d8' },
  { id: 'debris-fy1c', label: 'Detriti Fengyun-1C (test ASAT 2007)', group: 'fengyun-1c-debris', color: '#ff6b6b' },
  { id: 'debris-c2251', label: 'Detriti Cosmos 2251 (collisione 2009)', group: 'cosmos-2251-debris', color: '#ff8f6b' },
  { id: 'debris-ir33', label: 'Detriti Iridium 33 (collisione 2009)', group: 'iridium-33-debris', color: '#ffab6b' },
  { id: 'debris-c1408', label: 'Detriti Cosmos 1408 (test ASAT 2021)', group: 'cosmos-1408-debris', color: '#ff6bb0' },
];

/** Cataloghi di corpi minori dal JPL Small-Body Database (nuvole di punti eliocentriche). */
export interface SmallBodyGroupDef {
  id: string;
  label: string;
  color: string;
}

export const SMALL_BODY_GROUPS: readonly SmallBodyGroupDef[] = [
  { id: 'pha', label: 'Potenzialmente pericolosi (PHA)', color: '#ff7a6b' },
  { id: 'neo', label: 'Near-Earth (NEO, tutti)', color: '#ffb35c' },
  { id: 'big', label: 'Asteroidi più grandi (H < 13)', color: '#c9b48f' },
  { id: 'tjn', label: 'Troiani di Giove', color: '#8fd99b' },
  { id: 'tno', label: 'Oggetti transnettuniani', color: '#8fb3d9' },
];
