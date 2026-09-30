/**
 * Entry point del frontend (servito da Vite).
 *
 * Flusso per frame:
 *   tempo   → LIVE: la simulazione segue l'ora reale · altrimenti Simulation.update(dt) con time-warp
 *   fisica  → view.updatePositions()        (corpi naturali → scena tramite ScaleManager)
 *   dati    → objects.update(t), groups.tick(t)  (oggetti artificiali reali al tempo simulato)
 *           → artView.update(...)            (marcatori, orbite, traiettorie, cataloghi)
 *   camera  → cameraCtl.update(dt)           (segue il corpo o l'oggetto agganciato)
 *   aspetto → view.updateAppearance(...)     (dimensioni min-pixel, orbite, etichette)
 *   render  → WebGL + etichette HTML
 * Il frontend legge soltanto lo stato del motore fisico: lo modifica solo su comando esplicito
 * dell'utente (pausa, warp, LIVE).
 */
import './style.css';
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { setMaxAnisotropy } from './graphics/assets.ts';
import { LensFlare } from './graphics/lensFlare.ts';
import { lineRebaser } from './graphics/precision.ts';
import { EarthTiles, type SurfaceSource } from './graphics/earthTiles.ts';
import { ArtificialObjectsView } from './graphics/ArtificialObjectsView.ts';
import { LAUNCH_ID, LaunchView } from './graphics/LaunchView.ts';
import { LaunchMission, type MissionConfig } from './launch/mission.ts';
import { snapshot } from './launch/propagator.ts';
import { FlightHud } from './ui/FlightHud.ts';
import { LaunchPanel } from './ui/LaunchPanel.ts';
import { CameraController, type FocusProvider } from './graphics/CameraController.ts';
import { Picker } from './graphics/Picker.ts';
import { ScaleManager } from './graphics/ScaleManager.ts';
import { SUN_LIGHT, SolarSystemView } from './graphics/SolarSystemView.ts';
import { simTimeFromDate } from './physics/constants.ts';
import { Simulation, TIME_WARP_LEVELS } from './physics/simulation.ts';
import { ArtificialObjects } from './spacecraft/ArtificialObjects.ts';
import { SatelliteGroups } from './spacecraft/SatelliteGroups.ts';
import { SmallBodyGroups } from './spacecraft/SmallBodyGroups.ts';
import { EphemerisSync } from './spacecraft/ephemerisSync.ts';
import { ArtificialPanel } from './ui/ArtificialPanel.ts';
import { HudControls } from './ui/HudControls.ts';

const app = document.getElementById('app');
if (!app) throw new Error('#app non trovato');

// ─── Renderer WebGL a pieno schermo ───
const pixelRatio = Math.min(window.devicePixelRatio, 2);
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
app.appendChild(renderer.domElement);

// Livello HTML per le etichette
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.className = 'label-layer';
app.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
// ambiente tenue per i modelli 3D (riflessi sui metalli, luce diffusa della Terra): non tocca i pianeti
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.26;
  pmrem.dispose();
}
// near/far molto distanti: il depth buffer logaritmico gestisce sia la scala reale sia quella grafica
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1e-9, 1e8);
camera.position.set(0, 330, 520);

// ─── Post-processing: bagliore (bloom) del Sole e delle luci intense, poi tone mapping ───
const renderTarget = new THREE.WebGLRenderTarget(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio, {
  type: THREE.HalfFloatType,
  samples: 4,
});
const composer = new EffectComposer(renderer, renderTarget);
composer.setPixelRatio(pixelRatio);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.6, 0.96);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const lensFlare = new LensFlare();
lensFlare.setAspect(window.innerWidth / window.innerHeight);

// ─── Motore fisico (STEP 1) ───
const sim = Simulation.fromDate(new Date());
/** LIVE: la simulazione segue l'ora reale (le telemetrie sono quelle di "adesso"). */
let live = true;
/** Posizioni reali JPL (DE440) per Sole, pianeti e lune all'avvio e a ogni salto di data. */
const ephem = new EphemerisSync(sim);

// ─── Oggetti artificiali: dati reali ───
const objects = new ArtificialObjects(sim);
const groups = new SatelliteGroups();
const smallBodies = new SmallBodyGroups();

// ─── Grafica ───
const scale = new ScaleManager('log');
const view = new SolarSystemView(sim, scale, scene, pixelRatio);
const artView = new ArtificialObjectsView(objects, groups, sim, scale, view, scene, pixelRatio, smallBodies);

// superficie terrestre ad alta risoluzione (tile satellitari + rilievo) quando la camera è vicina
const earthTiles = new EarthTiles(sim, scale, view);
scene.add(earthTiles.group);
const creditEl = document.createElement('div');
creditEl.className = 'map-credit';
app.appendChild(creditEl);

const launchView = new LaunchView(sim, scale, view, scene, pixelRatio);
launchView.earthTiles = earthTiles;
launchView.setCamera(camera);
/** Missione di lancio in corso (simulatore di lancio). */
let mission: LaunchMission | null = null;

const focusProvider: FocusProvider = {
  scenePosition: (id) => (id === LAUNCH_ID ? launchView.scenePosition() : view.scenePosition(id) ?? artView.scenePosition(id)),
  focusDistance: (id) => (id === LAUNCH_ID ? launchView.focusDistance() : sim.has(id) ? view.focusDistance(id) : artView.focusDistance(id)),
  minDistance: (id) => (id === LAUNCH_ID ? launchView.minDistance() : sim.has(id) ? view.minDistance(id) : artView.minDistance(id)),
  focusDirection: (id) => (id === LAUNCH_ID ? launchView.focusDirection() : sim.has(id) ? undefined : artView.focusDirection(id)),
  avoid: (id) => (id === LAUNCH_ID ? launchView.avoid() : sim.has(id) ? undefined : artView.avoid(id)),
};
const cameraCtl = new CameraController(camera, renderer.domElement, focusProvider, 'sun');

/** Oggetto artificiale richiesto ma non ancora pronto (dati in download). */
let pendingFocus: string | null = null;

const focusOn = (id: string, animate = true) => {
  if (id === LAUNCH_ID) {
    if (!mission) return;
    pendingFocus = null;
    cameraCtl.focus(id, animate);
  } else if (!sim.has(id) && !artView.scenePosition(id)) {
    pendingFocus = id; // l'aggancio avverrà appena arrivano i dati
    objects.setVisible(id, true);
  } else {
    pendingFocus = null;
    cameraCtl.focus(id, animate);
  }
  view.focusId = id;
  artView.focusId = id;
  launchView.focused = id === LAUNCH_ID;
  hud.setFocus(id);
  artPanel.setFocus(id);
};

const focusNorad = (norad: number) => {
  const found = groups.findByNorad(norad);
  if (!found) return;
  const o = objects.promote(found.omm, found.group.def.color);
  focusOn(o.def.id);
};

const setLive = (on: boolean) => {
  live = on;
  hud.live = on;
  if (on) {
    sim.resetToDate(new Date());
    sim.timeWarp = 1;
    sim.paused = false;
    if (!mission) void ephem.sync();
  }
};

const hud = new HudControls(app, sim, {
  onFocus: (id) => focusOn(id),
  onScaleMode: (mode) => {
    scale.mode = mode;
    view.updatePositions();
    artView.update(camera, 0);
    focusOn(cameraCtl.focusId, false); // ricolloca la camera alla nuova scala
  },
  onToggleOrbits: (show) => {
    view.showOrbits = show;
    artView.showOrbits = show;
  },
  onToggleLabels: (show) => {
    view.showLabels = show;
    artView.showLabels = show;
  },
  onLive: () => setLive(true),
  onManualTime: () => (live = hud.live = false),
  onGoToDate: (date) => goToDate(date),
  onOpenLaunch: () => launchPanel.open(),
  onSurfaceSource: (src) => earthTiles.setSource(src as SurfaceSource),
});
hud.live = live;
hud.ephem = ephem;
void ephem.sync();

/** Salto a una data: tutto (pianeti, lune, satelliti, sonde, asteroidi) viene ricalcolato a quell'istante. */
const goToDate = (date: Date) => {
  live = hud.live = false;
  if (mission && mission.phase !== 'complete' && mission.phase !== 'failed') endMission();
  sim.resetToDate(date);
  view.updatePositions();
  void ephem.sync();
};

const flightHud = new FlightHud(app, {
  onFocus: () => focusOn(LAUNCH_ID),
  onClose: () => endMission(),
});

const endMission = () => {
  mission = null;
  launchView.setMission(null);
  flightHud.hide();
  if (cameraCtl.focusId === LAUNCH_ID) focusOn('earth');
};

const startMission = (cfg: MissionConfig) => {
  // lancio lontano nel tempo (finestra calcolata o data scelta): la simulazione salta a T−60 s
  if (cfg.launchTime > sim.time + 300 || cfg.launchTime < sim.time) {
    live = hud.live = false;
    sim.resetToTime(cfg.launchTime - 60);
    void ephem.sync();
  }
  sim.timeWarp = 1;
  sim.paused = false;
  mission = new LaunchMission(sim, cfg);
  // posizione in rampa e veicolo in scena prima di agganciare la camera
  mission.update(snapshot(sim), snapshot(sim));
  launchView.setMission(mission);
  view.updatePositions();
  launchView.update(0, view.showOrbits);
  flightHud.show(mission);
  view.updatePositions();
  focusOn('earth', false);
  focusOn(LAUNCH_ID);
};

const launchPanel = new LaunchPanel(app, sim, { onLaunch: startMission });
launchView.onLabelClick = () => focusOn(LAUNCH_ID);

const focusSmallBody = (fullName: string, color: string) => {
  const o = objects.promoteSmallBody(fullName, color);
  focusOn(o.def.id);
};

const artPanel = new ArtificialPanel(app, objects, groups, {
  onFocus: (id) => focusOn(id),
  onFocusNorad: focusNorad,
  onFocusSmallBody: focusSmallBody,
}, hud.root, smallBodies);

view.onLabelClick = (id) => focusOn(id);
artView.onLabelClick = (id) => focusOn(id);
new Picker(
  camera,
  renderer.domElement,
  [launchView.pickSource(), artView.markerPickSource(), view.asPickSource(), artView.cloudPickSource(), artView.smallBodyPickSource()],
  (id) => {
    if (id.startsWith('norad:')) focusNorad(Number(id.slice(6)));
    else if (id.startsWith('sb:')) {
      const [, gid, idx] = id.split(':');
      const name = smallBodies.nameAt(gid, Number(idx));
      if (name) focusSmallBody(name, smallBodies.groups.get(gid)!.def.color);
    } else focusOn(id);
  },
);

// Suggerimenti comandi
const help = document.createElement('div');
help.className = 'help';
help.innerHTML =
  '<b>Sinistro</b> ruota · <b>Destro</b> pan · <b>Rotella</b> zoom · <b>Clic</b> su un oggetto: aggancia · ' +
  '<b>Spazio</b> pausa · <b>,</b> / <b>.</b> warp −/+ · <b>L</b> LIVE';
app.appendChild(help);

// ─── Scorciatoie da tastiera ───
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    hud.togglePause();
  } else if (e.key === '.' || e.key === ',') {
    const levels = TIME_WARP_LEVELS as readonly number[];
    let i = levels.findIndex((w) => w >= sim.timeWarp);
    if (i < 0) i = levels.length - 1;
    i = Math.max(0, Math.min(levels.length - 1, i + (e.key === '.' ? 1 : -1)));
    hud.setWarp(levels[i]);
  } else if (e.key === 'l' || e.key === 'L') {
    setLive(true);
  }
});

// ─── Resize ───
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  lensFlare.setAspect(w / h);
  labelRenderer.setSize(w, h);
  cameraCtl.setAspect(w / h);
});

// ─── Main loop ───
view.updatePositions();
focusOn('sun', false);

/**
 * Avanza la simulazione di `seconds`. Con una missione di lancio attiva lo fa a blocchi di al massimo
 * 30 minuti: la sonda interpola le posizioni dei corpi fra l'inizio e la fine di ogni blocco, e blocchi
 * troppo lunghi renderebbero imprecisa la posizione della Luna durante un avvicinamento.
 */
const advance = (seconds: number) => {
  if (!mission) {
    sim.advance(seconds);
    return;
  }
  let left = seconds;
  while (left > 1e-6) {
    const h = Math.min(left, 1800);
    const a = snapshot(sim);
    sim.advance(h);
    mission.update(a, snapshot(sim));
    left -= h;
  }
};

/**
 * Luce sui modelli 3D dell'oggetto inquadrato: nell'ombra della Terra (o di un altro corpo) il Sole
 * non lo illumina. Resta un minimo di luce ambiente per distinguerne la sagoma.
 */
const updateModelLighting = () => {
  const id = cameraCtl.focusId;
  let pos = null as ReturnType<typeof sim.position> | null;
  let center = '';
  if (id === LAUNCH_ID && mission) {
    pos = mission.position;
    center = 'earth';
  } else {
    const o = objects.get(id);
    if (o && o.valid) {
      pos = sim.position(o.def.center).add(o.rel);
      center = o.def.center;
    }
  }
  let f = 1;
  if (pos && center) {
    const near = center === 'sun' ? [] : [center, ...sim.bodies.filter((b) => b.parentId === center).map((b) => b.id)];
    if (center === 'moon') near.push('earth');
    f = view.sunlightAt(pos, near);
  }
  view.sunLight.intensity = SUN_LIGHT * f;
  scene.environmentIntensity = 0.06 + 0.2 * f;
};

/**
 * Con la telemetria di volo aperta (in basso al centro) il punto inquadrato viene spostato più in alto,
 * così il veicolo non finisce dietro il pannello.
 */
let viewShift = 0;
const updateViewOffset = () => {
  const hudOpen = !flightHud.root.hidden && !flightHud.root.classList.contains('collapsed');
  const target = hudOpen && cameraCtl.focusId === LAUNCH_ID ? 0.2 : 0;
  if (Math.abs(target - viewShift) < 1e-3) {
    if (viewShift === target) return;
    viewShift = target;
  } else viewShift += (target - viewShift) * 0.15;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (viewShift === 0) camera.clearViewOffset();
  else camera.setViewOffset(w, h, 0, h * viewShift, w, h);
};

let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (live) {
    // Segue l'orologio reale (anche dopo che la scheda è rimasta in background)
    const lag = simTimeFromDate(new Date()) - sim.time;
    if (Math.abs(lag) > 6 * 3600) sim.resetToDate(new Date());
    else if (lag > 0) advance(lag);
  } else if (mission) {
    // con una missione attiva il tempo avanza a blocchi (vedi advance)
    const requested = sim.paused ? 0 : dt * sim.timeWarp;
    const cap = sim.maxSubstepsPerFrame * sim.maxStep;
    const simulated = Math.min(requested, cap);
    advance(simulated);
    sim.lastFrame = { requested, simulated, substeps: Math.ceil(simulated / sim.maxStep), stepSize: sim.maxStep, limited: simulated < requested };
  } else {
    sim.update(dt); // fisica + time-warp (sotto-passi gestiti dal motore)
  }

  view.updatePositions(); // fisica → scena
  objects.update(sim.time); // oggetti artificiali al tempo simulato
  groups.tick(sim.time); // cataloghi CelesTrak (worker SGP4)
  smallBodies.tick(sim.time); // cataloghi di asteroidi (worker kepleriano)
  artView.update(camera, dt);
  launchView.update(dt, view.showOrbits);

  if (pendingFocus && artView.scenePosition(pendingFocus)) focusOn(pendingFocus);
  updateModelLighting();
  cameraCtl.update(dt); // aggancio camera
  updateViewOffset();
  earthTiles.update(camera, renderer.domElement.clientHeight);
  if (creditEl.textContent !== earthTiles.credit) creditEl.textContent = earthTiles.credit;
  // linee vicine alla camera riscritte rispetto a un'origine locale (precisione float32)
  lineRebaser.update(cameraCtl.controls.target, camera.position.distanceTo(cameraCtl.controls.target));
  view.updateAppearance(camera, renderer.domElement.clientHeight, dt);

  // quando il Sole riempie lo schermo il bagliore si riduce (come l'esposizione di una fotocamera)
  const sunAng = view.sunVisualRadius() / Math.max(camera.position.length(), 1e-9);
  bloom.strength = THREE.MathUtils.clamp(0.6 - sunAng * 1.2, 0.12, 0.6);
  composer.render(dt);
  lensFlare.update(camera, view.sunVisualRadius(), view.sunOccluders());
  renderer.autoClear = false;
  renderer.render(lensFlare.scene, lensFlare.camera);
  renderer.autoClear = true;
  labelRenderer.render(scene, camera);
  hud.update(dt);
  artPanel.update(dt);
  flightHud.update(dt);
});

// Accesso da console del browser per il debug (es. solarsim.objects.telemetry('iss'))
Object.assign(window, {
  solarsim: { sim, scale, view, earthTiles, renderer, composer, bloom, lensFlare, artView, objects, groups, cameraCtl, camera, launchPanel, get mission() { return mission; } },
});
