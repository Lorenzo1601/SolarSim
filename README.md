# SolarSim — Simulatore del Sistema Solare

Simulatore interattivo di meccanica orbitale: Sistema Solare reale (N-body), lancio di sonde,
manovre (Hohmann, flyby), camera 3D e time-warp. Stack: **TypeScript + Three.js + Vite**.

## Requisiti
- Node.js **≥ 22.18** (esegue TypeScript nativamente per test e demo)

```bash
npm install      # dipendenze: three, satellite.js, @types/three, vite, typescript
npm run dev      # avvia il simulatore 3D su http://localhost:5173 (apre il browser)
npm test         # test: fisica, ScaleManager, dati spaziali, simulatore di lancio
npm run demo     # stato del Sistema Solare oggi + integrazione di 1 anno (console)
npm run build    # typecheck + build di produzione in dist/
```

## Stato di avanzamento
| Step | Contenuto | Stato |
|---|---|---|
| 1 | Motore fisico: costanti, catalogo corpi, Keplero, N-body (Verlet/RK4), time-warp, telemetria | ✅ |
| 2 | Rendering Three.js del Sistema Solare e delle orbite | ✅ |
| 3 | Telecamera, scale (reale/logaritmica), controlli time-warp | ✅ (base) |
| 3b | Oggetti artificiali reali: satelliti (CelesTrak/SGP4), sonde (JPL Horizons), DSN live | ✅ |
| 3c | Asteroidi e TNO (JPL SBDB), controllo data passato/futuro con effemeridi JPL DE440 | ✅ |
| 4 | Simulatore di lancio: razzi reali, salita fisica, missioni LEO/SSO/GTO/GEO/Luna/pianeti | ✅ |
| 5 | UI telemetria di volo e pannello di lancio | ✅ |
| 6 | Grafica realistica: texture NASA, atmosfere, Sole, eclissi, cielo reale, modelli 3D NASA | ✅ |

## Architettura (STEP 1)
```
src/
  data/bodies.ts          catalogo: Sole, 8 pianeti, Plutone, 12 lune (GM, raggi, poli, elementi)
  physics/
    constants.ts          G, AU, J2000, conversioni data ↔ tempo di simulazione
    vec3.ts               vettore 3D in doppia precisione
    frames.ts             eclittica J2000 ↔ equatoriale, piani equatoriali dei pianeti
    kepler.ts             equazione di Keplero, elementi ↔ stato, periasse/apoasse, campionamento orbite
    initialState.ts       condizioni iniziali baricentriche a una data qualunque (1800–2050)
    nbody.ts              motore N-body su Float64Array, integratori Verlet (simplettico) e RK4
    simulation.ts         tempo, time-warp con sotto-passi, SOI, telemetria, sonde
    index.ts              API pubblica
tests/physics.test.ts     16 test (Keplero, roundtrip, 2 corpi, energia, effemeridi, Luna, LEO, warp)
scripts/demo.ts           demo da console
```

### Scelte principali
- **Unità SI e doppia precisione** ovunque; frame inerziale = eclittica J2000 centrata sul baricentro
  del Sistema Solare (quantità di moto totale nulla → nessuna deriva).
- **GM invece di G·M**: i parametri gravitazionali sono noti con precisione molto maggiore delle masse.
- **Pianeti + lune come sistemi**: gli elementi di Standish descrivono il baricentro del sistema;
  pianeta e lune sono distribuiti attorno ad esso (Terra–Luna corretto per costruzione).
- **Integratore di default Velocity Verlet** (simplettico): energia conservata a ~1e-13 su un anno.
  RK4 disponibile per traiettorie brevi di precisione.
- **Passo adattato all'orbita più rapida** (Phobos, 400 passi/orbita ≈ 69 s). Il time-warp suddivide
  ogni frame in sotto-passi; se il budget di CPU per frame viene superato il warp viene limitato e
  segnalato (`FrameReport.limited`).
- **Sonde come particelle di prova** (μ = 0): subiscono la gravità di tutti i corpi senza perturbarli.

### Precisione verificata (`npm run demo`)
Dopo 1 anno di integrazione N-body, scarto rispetto alle effemeridi kepleriane JPL: < 0.04° in
longitudine e < 0.02% in distanza per tutti i pianeti; |ΔE/E| ≈ 4·10⁻¹³ (Verlet).
Warp 1.000.000× a 60 fps: ~240 sotto-passi/frame, < 0.5 ms/frame.

## Frontend 3D (STEP 2–3)
```
index.html                    entry point di Vite
vite.config.ts
src/
  main.ts                     renderer, scena, main loop requestAnimationFrame
  style.css                   HUD ed etichette
  graphics/
    ScaleManager.ts           fisica (m, eclittica Z-su) → scena Three.js (Y-su), scala log/reale
    SolarSystemView.ts        mesh dei corpi, anelli di Saturno, orbite (kepler.ts), etichette
    CameraController.ts       OrbitControls + aggancio/inseguimento del corpo selezionato
    Picker.ts                 selezione col mouse (Raycaster + fallback in spazio schermo)
    textures.ts               texture procedurali (alone solare, anelli, stelle)
  ui/HudControls.ts           pulsanti Pausa/1x/100.000x, menu "Aggancia camera", scala, info
tests/scale.test.ts           test dello ScaleManager
tests/spacecraft.test.ts      TEME→J2000, Horizons, Hermite, DSN (dati reali in tests/fixtures)
```

**Main loop:** `dt` reale → `sim.update(dt)` → `view.updatePositions()` (via ScaleManager) →
`cameraCtl.update(dt)` → `view.updateAppearance()` → render. La grafica legge soltanto lo stato
del motore; gli unici comandi verso la fisica sono pausa e time-warp.

**Scale:**
- *Logaritmica*: `s = 120 · log10(1 + d / 0.03 AU)` in direzione radiale dal Sole; raggi
  `R_vis = 0.13 · R_km^0.3` (Sole ×2.2, lune ×0.5); lune a `R_vis_pianeta · (1.8 + 2.5·log10(d/R_pianeta))`.
- *Reale*: 1 unità = 1 milione di km, raggi e distanze veri.
- In entrambe: raggio minimo di 3 px a video, così nessun corpo sparisce (solo grafica).
- Depth buffer logaritmico (near 1e-7, far 1e8) per passare da Phobos a Plutone senza artefatti.

**Comandi:** sinistro ruota · destro pan · rotella zoom · clic su corpo/etichetta = aggancia ·
Spazio pausa · `,` / `.` scorrono i livelli di warp (1× … 1.000.000×).
In console del browser: `solarsim.sim.telemetry('earth')`.

## Oggetti artificiali con dati reali
Pannello **Oggetti artificiali** (a destra): scegli cosa visualizzare, cerca per nome o numero NORAD,
aggancia la camera (◎). La scelta viene ricordata dal browser.

| Fonte | Oggetti | Come |
|---|---|---|
| **CelesTrak** (elementi GP/TLE NORAD) | ISS, Tiangong, Hubble, Chandra, XMM, TESS, Fermi, Swift, NuSTAR, IXPE, XRISM, Landsat, Terra, Aqua, NOAA-20, GOES, Vanguard 1 + cataloghi (tutti i ~16.600 attivi, Starlink, GNSS, geostazionari, detriti…) | propagazione **SGP4** (satellite.js), cataloghi in un Web Worker |
| **JPL Horizons** (effemeridi ufficiali) | JWST, Euclid, SOHO, Voyager 1/2, New Horizons, Parker, Solar Orbiter, Europa Clipper, JUICE, BepiColombo, Lucy, Psyche, Hera, OSIRIS-APEX, Hayabusa2, STEREO-A, Gaia, Juno, MRO, Mars Express, TGO, Odyssey, Hope, LRO, Danuri, Chandrayaan-2, Pioneer 10/11 | tabelle di vettori interpolate (Hermite), traiettoria storica dal lancio |
| **NASA DSN Now** | tutte le sonde del Deep Space Network | stato **in tempo reale** dei collegamenti: antenna, velocità dati, distanza misurata, tempo luce |

- **LIVE** (pulsante o tasto `L`): la simulazione segue l'ora reale → posizioni e telemetrie sono quelle di adesso.
  Con il time-warp i dati vengono calcolati per la data simulata (TLE: affidabili per giorni/settimane;
  JPL: finché copre la data, poi estrapolazione kepleriana segnalata).
- Telemetria: quota, velocità, lat/lon (satelliti), perigeo/apogeo, periodo, inclinazione, età del TLE,
  distanza da Sole e Terra, tempo luce, collegamento DSN.
- **Proxy locale con cache** (`server/spaceDataPlugin.ts`, attivo con `npm run dev`/`npm run preview`):
  aggira il CORS e rispetta i limiti di CelesTrak (cache 2 h su disco in `.cache/space-data`).
- Validazione: `node scripts/validate-iss.ts <file OMM>` confronta la ISS da SGP4 con JPL Horizons
  (scarto misurato: ~0,2 km).
- Non inclusi: il catalogo completo dei detriti (~30.000 oggetti) richiede un account Space-Track;
  sono disponibili i principali gruppi di detriti pubblicati da CelesTrak.
- **Archivio storico dei satelliti**: se la data simulata è a più di 20 giorni dall'epoca del TLE,
  la posizione viene presa dalle effemeridi storiche di JPL Horizons (quando esistono: ISS, Hubble,
  Chandra, TESS…); altrimenti l'oggetto viene segnalato come "dati non disponibili".
- **JWST** e gli altri osservatori in L2 hanno anche l'orbita di halo disegnata nel sistema
  rotante Sole–Terra (la traiettoria vera attorno a L2, non la spirale inerziale).
- La telemetria dell'oggetto selezionato compare nella colonna di sinistra, sotto i comandi,
  e non copre più la lista a destra.

## Asteroidi e corpi minori (JPL SBDB)
- 22 asteroidi famosi (Cerere, Vesta, Pallade, Psyche, Bennu, Ryugu, Apophis, Didymos, i Troiani di
  Lucy, 2024 YR4…) e 5 TNO (Eris, Haumea, Makemake, Sedna, Arrokoth), con traiettoria JPL Horizons e
  dati fisici dal Small-Body Database (diametro, magnitudine H, rotazione, albedo, classe).
- **Nuvole di punti** (sezione "Cataloghi di asteroidi"): NEO, PHA, asteroidi grandi (H < 13),
  Troiani di Giove, TNO — elementi orbitali da SBDB Query, propagati (Keplero eliocentrico) in un
  Web Worker. Ricerca per nome nel pannello; clic su un punto per selezionarlo.

## Data e ora: LIVE, time-warp, passato e futuro
- **LIVE** = ora reale. Il cursore del warp va da 1× a 1.000.000× (anche con `,` e `.`).
- Campo data/ora + **Vai**: salta a qualsiasi data. A ogni salto (e all'avvio) posizioni e velocità
  di Sole, pianeti e lune vengono riallineate alle **effemeridi JPL DE440** (Horizons), poi l'N-body
  prosegue da lì.
- Riga di qualità dei dati: *passato* → dati storici/archivio; *futuro* → **stima** (pianeti e
  asteroidi calcolati, sonde da traiettorie JPL previste finché esistono, poi estrapolazione).
- Verifiche: Apophis al passaggio del 13/04/2029 a ~38.000 km dal centro della Terra; New Horizons
  al flyby di Plutone (14/07/2015) a ~13.700 km.

## Simulatore di lancio (🚀)
```
src/launch/
  earthModel.ts   Terra: GMST, geodetiche↔ECEF, rotazione, J2
  atmosphere.ts   atmosfera standard US 1976 (+ esponenziale oltre 86 km), Cd(Mach)
  rockets.ts      razzi reali (Falcon 9/Heavy, Atlas V 551, Ariane 64, Vega-C, Electron, SLS, Saturn V, Starship) e basi
  ascent.ts       salita fisica 3D: stadi, booster, spinta vs pressione, max-Q, max-g, guida a circuito chiuso
  propagator.ts   integratore DOPRI5 a passo adattivo (N-body + J2 + resistenza + spinta finita), predittore
  planner.ts      Lambert, porkchop, finestre di lancio (piano orbitale, Luna, pianeti), iperbole di fuga
  mission.ts      sequenza di missione: salita → orbita → manovre → correzioni → cattura
src/ui/LaunchPanel.ts   finestra di configurazione (razzo e stadi modificabili, carico, base, orbita)
src/ui/FlightHud.ts     telemetria di volo in tempo reale, grafici, registro eventi
src/graphics/LaunchView.ts  veicolo, scia e traiettoria prevista nella scena
```
- **Razzo**: scegli un modello reale o modifica ogni stadio (masse secca/propellente, spinta a livello
  del mare e nel vuoto, Isp, numero di motori/booster, recupero). Il pannello calcola Δv disponibile,
  Δv necessario e un verdetto di fattibilità prima del lancio.
- **Missioni**: LEO, SSO (inclinazione eliosincrona calcolata), GTO, GEO (manovre di apogeo),
  **Luna** (TLI, correzioni di rotta, inserimento in orbita lunare), **pianeti** (porkchop di Lambert,
  C3, iniezione, TCM-1/2/3, cattura o flyby).
- **Finestra di lancio**: calcola data e ora in cui il piano dell'orbita di parcheggio contiene
  l'asintoto di partenza (pianeti) o la posizione futura della Luna.
- **Fisica di volo**: gravità N-body con Terra J2, atmosfera, resistenza, spinta finita, consumo di
  propellente, separazioni. L'iniezione interplanetaria usa la guida "velocità da guadagnare" verso
  l'iperbole di fuga; le correzioni sono calcolate con Newton sul predittore N-body.
- Telemetria: quota, velocità, accelerazione (g), pressione dinamica, massa, stadio, apoasse/periasse,
  inclinazione, Δv residuo, distanza dalla Terra + grafici e registro eventi (Max-Q, MECO, separazioni…).
- Esempi verificati: Falcon 9 porta ~22,8 t in LEO; Saturn V → orbita lunare 70–80 × 300 km;
  Atlas V 551 → Marte, cattura 240 × 64.000 km (TCM di pochi m/s).
- Limiti: i dati dei razzi sono pubblici e approssimati; la guida è generica (non quella di bordo dei
  singoli vettori); niente flyby gravitazionali multipli (es. Mercurio diretto è quasi impossibile,
  come nella realtà).

## Grafica realistica
```
src/graphics/
  appearance.ts      texture e parametri ottici di ogni corpo, struttura reale degli anelli di Saturno
  bodyRotation.ts    orientamento IAU (polo, meridiano W(t)); Terra dal tempo siderale (stesso frame dei satelliti)
  shaders.ts         superfici, nubi, atmosfere, anelli, Sole e corona (GLSL, depth buffer logaritmico)
  sky.ts             Via Lattea (NASA SVS) + 9.096 stelle vere (BSC5) con magnitudine e colore
  lensFlare.ts       riflessi dell'obiettivo, nascosti se un corpo copre il Sole
  spacecraftModels.ts  modelli NASA (glTF), sonde/asteroidi/razzi procedurali, getto dei motori
public/textures, public/models, public/draco   dati (vedi public/CREDITS.md)
```
- **Pianeti e lune** con mappe reali (Blue Marble, LRO, MESSENGER, Cassini, Voyager, New Horizons),
  ruotati secondo i poli e i periodi IAU; Terra con nubi, luci notturne, riflesso del Sole sugli oceani,
  atmosfera con tramonto al terminatore; Luna con rilievo (LOLA); Giove e Saturno schiacciati ai poli.
- **Superficie "ray-traced"**: il colore, la normale e la profondità vengono dall'ellissoide esatto,
  così anche a pochi metri dal suolo (razzo in rampa) il terreno non ha sfaccettature.
- **Sole**: granulazione animata, macchie, oscuramento al bordo, corona, bagliore (bloom) e lens flare.
- **Ombre ed eclissi** calcolate con la geometria reale: eclissi di Sole e di Luna (Luna rossa
  nell'ombra della Terra), ombre delle lune di Giove, ombra degli anelli su Saturno e di Saturno sugli anelli.
  Verificate con l'eclissi di Luna del 3/3/2026 e l'eclissi di Sole del 12/8/2026 (ombra su Islanda/Spagna).
- **Cielo reale**: Via Lattea e costellazioni nelle posizioni vere.
- **Oggetti artificiali in 3D**: avvicinandosi (o selezionandoli) compaiono i modelli NASA in scala reale
  rispetto al corpo vicino, orientati lungo l'orbita; nell'ombra della Terra non sono illuminati.
  Il primo piano mostra il veicolo con il pianeta sullo sfondo; con la rotella si torna alla vista d'insieme.
- **Superficie terrestre da vicino**: sotto i ~2.500 km di quota la Terra viene ricoperta da tile di
  immagini satellitari reali (Esri World Imagery fino a ~0,5 m/pixel, oppure Sentinel-2 cloudless di EOX
  a 10 m) con il rilievo del terreno (AWS Terrain Tiles), scelte con un quadtree in base alla distanza.
  In rampa si vedono la piattaforma di lancio, le strade e la costa; il razzo poggia sul terreno.
  Sorgente selezionabile nel pannello ("Superficie terrestre da vicino"); le tile passano dal proxy
  locale e restano in cache su disco (`.cache/space-data`). Richiede la connessione a Internet.
- **Lancio**: Saturn V con il modello NASA, gli altri razzi procedurali, getto dei motori che si allarga
  salendo di quota; camera di fianco al razzo con il suolo e l'orizzonte.

### Limiti noti
- Le texture sono al massimo 4096 px (≈10 km per pixel sulla Terra): nei primi piani al suolo si vede
  un dettaglio procedurale, non immagini ad alta risoluzione. Venere e Urano usano bande sintetiche
  (le foto reali mostrano nubi quasi uniformi), alcune sonde senza modello NASA hanno una sagoma generica.
- La grafica richiede una scheda video con WebGL 2 (bloom e ombre sono calcolati sulla GPU).
- Le fasi iniziali delle lune (tranne la Luna) sono approssimate; piani orbitali e periodi sono realistici.
- Elementi planetari validi 1800–2050; TT−UTC (~69 s) trascurato.
- Niente relatività generale o pressione di radiazione (il J2 terrestre è incluso solo nel simulatore di lancio).
