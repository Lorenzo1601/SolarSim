/**
 * SolarSystemView — costruisce la scena 3D a partire dal catalogo del motore fisico e,
 * ad ogni frame, "legge" lo stato della simulazione e aggiorna le mesh.
 * Non modifica mai la simulazione.
 *
 * Per ogni corpo:
 *  - una sfera di raggio 1 (scalata ogni frame: raggio grafico, con minimo in pixel)
 *  - un'etichetta HTML (CSS2DObject), cliccabile
 *  - una linea d'orbita (LineLoop) calcolata dagli elementi osculanti con kepler.ts
 *    e trasformata con lo ScaleManager; per le lune la linea è agganciata al pianeta.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { poleVectorEcliptic } from '../physics/frames.ts';
import { sampleOrbit, stateToElements } from '../physics/kepler.ts';
import type { SimBody, Simulation } from '../physics/simulation.ts';
import { AU } from '../physics/constants.ts';
import type { Vec3 } from '../physics/vec3.ts';
import type { PickSource } from './Picker.ts';
import { ScaleManager } from './ScaleManager.ts';
import { APPEARANCE, RING_INNER_KM, RING_OUTER_KM, RING_PROFILE, type Appearance } from './appearance.ts';
import { loadTexture } from './assets.ts';
import { FLATTENING, bodyOrientation, bodyPole, earthAxes } from './bodyRotation.ts';
import {
  MAX_OCCLUDERS, createAtmosphereMaterial, createCloudMaterial, createCoronaMaterial, createLightUniforms,
  createPlanetMaterial, createRingMaterial, createSunMaterial,
} from './shaders.ts';
import { Sky } from './sky.ts';
import { lineRebaser } from './precision.ts';
import { createSaturnRingTexture } from './textures.ts';

const ORBIT_SAMPLES = 360;
/** Intensità della luce solare sui modelli 3D. */
export const SUN_LIGHT = 2.7;
/** Intervallo (secondi reali) fra due ricalcoli delle linee d'orbita. */
const ORBIT_REFRESH = 0.25;

interface OrbitVisual {
  /** Gruppo posizionato sul corpo primario (Sole = origine, pianeta per le lune). */
  group: THREE.Group;
  line: THREE.LineLoop;
  material: THREE.LineBasicMaterial;
  positions: Float32Array;
  primaryId: string;
}

export interface BodyVisual {
  body: SimBody;
  /** Sfera del corpo (ruota con il corpo; scala = raggio grafico, schiacciata ai poli). */
  mesh: THREE.Mesh;
  /** Gruppo non ruotato sul centro del corpo (etichetta, atmosfera), scala = raggio grafico. */
  anchor: THREE.Group;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  /** Raggio grafico di base (senza minimo in pixel) [unità scena]. */
  baseRadius: number;
  /** Posizione corrente in scena. */
  scenePos: THREE.Vector3;
  orbit: OrbitVisual | null;
  /** Uniform di luce/eclissi condivise dai materiali del corpo (assenti per il Sole). */
  light?: Record<string, THREE.IUniform>;
  surface?: THREE.ShaderMaterial;
  atmosphere?: THREE.Mesh;
  atmHeight?: number;
  clouds?: THREE.Mesh;
  /** Corpi che possono proiettare ombra su questo. */
  occluders: string[];
  flattening: number;
}

export class SolarSystemView {
  readonly root = new THREE.Group();
  readonly visuals = new Map<string, BodyVisual>();
  /** Stesso ordine di sim.bodies: i pianeti precedono le loro lune. */
  private ordered: BodyVisual[] = [];
  private readonly sim: Simulation;
  private readonly scale: ScaleManager;
  readonly sky: Sky;
  readonly sunLight: THREE.PointLight;
  private corona: THREE.Mesh | null = null;
  private sunMaterial: THREE.ShaderMaterial | null = null;
  private readonly timer = new THREE.Timer();
  private orbitClock = Infinity;
  private readonly q = new THREE.Quaternion();
  private readonly v3 = new THREE.Vector3();
  private readonly m4 = new THREE.Matrix4();
  private scaleVersion = -1;
  private tmp = new THREE.Vector3();

  focusId = 'sun';
  showOrbits = true;
  showLabels = true;
  /** Chiamata quando l'utente clicca un'etichetta. */
  onLabelClick: (id: string) => void = () => {};

  constructor(sim: Simulation, scale: ScaleManager, scene: THREE.Scene, pixelRatio = 1) {
    this.sim = sim;
    this.scale = scale;
    scene.add(this.root);

    // Luce per i modelli 3D (le superfici dei corpi usano shader propri): il Sole è nell'origine.
    this.sunLight = new THREE.PointLight(0xffffff, SUN_LIGHT, 0, 0);
    this.root.add(this.sunLight);
    this.root.add(new THREE.AmbientLight(0xffffff, 0.05));

    this.sky = new Sky(pixelRatio);
    scene.add(this.sky.root);

    const sphere = new THREE.SphereGeometry(1, 128, 64);
    for (const b of sim.bodies) this.addBody(b, sphere);
    this.linkOccluders();
    for (const v of this.ordered) {
      const pole = v.body.def?.pole;
      if (v.flattening > 0 && pole) scale.setOblateness(v.body.id, v.flattening, poleVectorEcliptic(pole.ra, pole.dec));
    }
  }

  /** Chi può fare ombra a chi: il pianeta alle sue lune, le lune al pianeta e fra loro. */
  private linkOccluders(): void {
    for (const v of this.ordered) {
      const b = v.body;
      if (b.kind === 'star') continue;
      const ids = new Set<string>();
      for (const o of this.ordered) {
        if (o === v || o.body.kind === 'star') continue;
        if (o.body.parentId === b.id) ids.add(o.body.id); // lune del pianeta
        if (b.parentId && b.parentId !== 'sun' && (o.body.id === b.parentId || o.body.parentId === b.parentId)) ids.add(o.body.id);
      }
      // prima i corpi più grandi (il limite è MAX_OCCLUDERS)
      v.occluders = [...ids].sort((a, c) => this.sim.get(c).radius - this.sim.get(a).radius).slice(0, MAX_OCCLUDERS);
    }
  }

  private addBody(b: SimBody, sphere: THREE.SphereGeometry): void {
    const color = new THREE.Color(b.def?.color ?? '#ffffff');
    const app: Appearance = APPEARANCE[b.id] ?? {};
    let material: THREE.Material;
    let light: Record<string, THREE.IUniform> | undefined;
    let surface: THREE.ShaderMaterial | undefined;
    if (b.kind === 'star') {
      this.sunMaterial = createSunMaterial();
      material = this.sunMaterial;
    } else {
      light = createLightUniforms();
      surface = createPlanetMaterial(light, color.clone().convertSRGBToLinear());
      material = surface;
      this.applyAppearance(surface, app);
    }
    const mesh = new THREE.Mesh(sphere, material);
    mesh.name = b.id;
    mesh.userData.bodyId = b.id;
    this.root.add(mesh);

    const anchor = new THREE.Group();
    this.root.add(anchor);

    if (b.kind === 'star') {
      const extent = 7;
      this.corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), createCoronaMaterial(extent));
      this.corona.raycast = () => {};
      this.corona.frustumCulled = false;
      this.corona.renderOrder = 1;
      this.corona.userData.extent = extent;
      this.root.add(this.corona);
    }

    let atmosphere: THREE.Mesh | undefined;
    if (app.atmosphere) {
      const a = app.atmosphere;
      const mat = createAtmosphereMaterial(new THREE.Vector3(...a.color), new THREE.Vector3(...(a.sunset ?? a.color)), a.strength);
      atmosphere = new THREE.Mesh(sphere, mat);
      atmosphere.scale.setScalar(1 + a.height);
      atmosphere.raycast = () => {};
      atmosphere.renderOrder = 2;
      anchor.add(atmosphere);
    }

    let clouds: THREE.Mesh | undefined;
    if (app.cloudMap && light && surface) {
      clouds = new THREE.Mesh(sphere, createCloudMaterial(light, surface));
      clouds.scale.setScalar(1.005);
      clouds.raycast = () => {};
      clouds.renderOrder = 1;
      mesh.add(clouds);
    }

    if (app.rings && light) mesh.add(this.createRings(b, light));

    // Etichetta HTML
    const el = document.createElement('div');
    el.className = `body-label kind-${b.kind}`;
    el.textContent = b.name;
    el.style.setProperty('--body-color', b.def?.color ?? '#fff');
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onLabelClick(b.id);
    });
    const label = new CSS2DObject(el);
    label.position.set(0, 1.25, 0); // sopra il corpo (l'ancora non ruota)
    label.center.set(0.5, 1);
    anchor.add(label);

    const visual: BodyVisual = {
      body: b,
      mesh,
      anchor,
      label,
      labelEl: el,
      baseRadius: 1,
      scenePos: new THREE.Vector3(),
      orbit: b.parentId ? this.createOrbit(b, color) : null,
      light,
      surface,
      atmosphere,
      atmHeight: app.atmosphere?.height,
      clouds,
      occluders: [],
      flattening: FLATTENING[b.id] ?? 0,
    };
    this.visuals.set(b.id, visual);
    this.ordered.push(visual);
  }

  /** Collega le texture reali (caricate in background: fino ad allora il colore medio del corpo). */
  private applyAppearance(m: THREE.ShaderMaterial, app: Appearance): void {
    const u = m.uniforms;
    if (app.tint) u.tint.value.set(...app.tint);
    u.regolith.value = app.regolith ?? 0;
    u.saturation.value = app.saturation ?? 1;
    u.limb.value = app.limbDarkening ?? 0;
    if (app.atmosphere) {
      u.atmColor.value.set(...app.atmosphere.color);
      u.atmStrength.value = app.atmosphere.strength * 0.5;
    }
    const bind = (file: string | undefined, key: string, flag: string, color: boolean) => {
      if (!file) return;
      loadTexture(file, color).then((t) => {
        u[key].value = t;
        u[flag].value = 1;
        if (key === 'map') u.mapWidth.value = (t.image as { width?: number })?.width ?? 2048;
      }).catch(() => {});
    };
    bind(app.map, 'map', 'hasMap', true);
    bind(app.normalMap, 'normalMap', 'hasNormal', false);
    bind(app.nightMap, 'nightMap', 'hasNight', true);
    bind(app.specularMap, 'specMap', 'hasSpec', false);
    bind(app.cloudMap, 'cloudMap', 'hasClouds', false);
  }

  private createOrbit(b: SimBody, color: THREE.Color): OrbitVisual {
    const positions = new Float32Array(ORBIT_SAMPLES * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: color.clone().lerp(new THREE.Color('#8aa4c8'), 0.35),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const line = new THREE.LineLoop(geo, material);
    line.frustumCulled = false;
    line.raycast = () => {};
    const group = new THREE.Group();
    group.add(line);
    this.root.add(group);
    return { group, line, material, positions, primaryId: b.parentId ?? 'sun' };
  }

  /** Anelli di Saturno: struttura reale, nel piano equatoriale (figli della sfera che ruota). */
  private createRings(b: SimBody, light: Record<string, THREE.IUniform>): THREE.Mesh {
    const R = b.radius / 1000;
    const inner = RING_INNER_KM / R;
    const outer = RING_OUTER_KM / R;
    const geo = new THREE.RingGeometry(inner, outer, 256, 1);
    const tex = createSaturnRingTexture(RING_PROFILE, RING_INNER_KM, RING_OUTER_KM);
    light.ringMap.value = tex;
    light.ringInner.value = inner;
    light.ringOuter.value = outer;
    light.hasRings.value = 1;
    const ring = new THREE.Mesh(geo, createRingMaterial(light));
    ring.rotation.x = -Math.PI / 2; // piano XY della RingGeometry → piano equatoriale XZ della sfera
    ring.raycast = () => {};
    ring.renderOrder = 3;
    return ring;
  }

  // ─────────────────────────── Aggiornamento per frame ───────────────────────────

  /** 1) Legge le posizioni dal motore e le converte in coordinate di scena. */
  updatePositions(): void {
    const sim = this.sim;
    const sunPos = sim.position('sun');
    if (this.scaleVersion !== this.scale.version) {
      for (const v of this.ordered) v.baseRadius = this.scale.visualRadius(v.body);
    }
    for (const v of this.ordered) {
      const b = v.body;
      if (b.kind === 'star') {
        v.scenePos.set(0, 0, 0);
      } else {
        const parent = b.parentId ? this.visuals.get(b.parentId) : undefined;
        if (parent && parent.body.kind !== 'star') {
          const rel = sim.position(b.id).sub(sim.position(parent.body.id));
          this.scale.mapSatelliteOffset(rel, parent.body, this.tmp);
          v.scenePos.copy(parent.scenePos).add(this.tmp);
        } else {
          this.scale.mapHeliocentric(sim.position(b.id).sub(sunPos), v.scenePos);
        }
      }
      v.mesh.position.copy(v.scenePos);
    }
  }

  /** 2) Dimensioni, orbite, etichette e cielo: dipendono dalla camera, vanno fatti dopo averla aggiornata. */
  updateAppearance(camera: THREE.PerspectiveCamera, viewportHeight: number, realDt: number): void {
    // Dimensioni (raggio grafico con minimo in pixel), rotazione, luce ed eclissi
    const t = this.sim.time;
    this.timer.update();
    const elapsed = this.timer.getElapsed();
    // polo di data della Terra (precessione) anche per la quota degli oggetti vicini
    this.scale.setOblateness('earth', FLATTENING.earth, earthAxes(t).pole);
    for (const v of this.ordered) {
      const dist = camera.position.distanceTo(v.scenePos);
      const r = Math.max(v.baseRadius * this.scale.equatorialFactor(v.body), this.scale.minRadiusAt(dist, camera, viewportHeight));
      // la mesh circoscrive l'ellissoide (lo shader traccia la superficie esatta al suo interno)
      const c = v.body.kind === 'star' ? 1 : 1.0012;
      v.mesh.scale.set(r * c, r * (1 - v.flattening) * c, r * c);
      // camera dentro la mesh (a pochi km dal suolo): si disegnano le facce interne, lo shader
      // trova comunque il punto giusto dell'ellissoide lungo il raggio visivo
      if (v.surface) v.surface.side = dist < r * c ? THREE.BackSide : THREE.FrontSide;
      // sotto lo strato di nubi (esagerato in quota) non lo si disegna: resta il cielo
      if (v.clouds) v.clouds.visible = dist > r * c * 1.005;
      v.anchor.position.copy(v.scenePos);
      v.anchor.scale.setScalar(r);
      if (bodyOrientation(this.sim, v.body.id, t, this.q)) v.mesh.quaternion.copy(this.q);
      if (v.body.kind === 'star') this.updateSun(v, r, camera, elapsed);
      else this.updateLighting(v, r, camera, t);
    }

    // Orbite: ricalcolo periodico (gli elementi osculanti cambiano lentamente) o al cambio di scala
    this.orbitClock += realDt;
    const scaleChanged = this.scaleVersion !== this.scale.version;
    if (this.showOrbits && (scaleChanged || this.orbitClock >= ORBIT_REFRESH)) {
      this.orbitClock = 0;
      for (const v of this.ordered) if (v.orbit) this.rebuildOrbit(v);
    }
    this.scaleVersion = this.scale.version;

    const focus = this.visuals.get(this.focusId);
    for (const v of this.ordered) {
      if (v.orbit) {
        const o = v.orbit;
        o.group.visible = this.showOrbits;
        o.group.position.copy(this.visuals.get(o.primaryId)?.scenePos ?? this.tmp.set(0, 0, 0));
        const highlighted = v.body.id === this.focusId || v.body.parentId === this.focusId;
        o.material.opacity = v.body.id === this.focusId ? 0.95 : highlighted ? 0.6 : 0.3;
      }
      v.label.visible = this.showLabels && this.isLabelVisible(v, focus, camera);
      v.labelEl.classList.toggle('focused', v.body.id === this.focusId);
    }

    this.sky.update(camera);
  }

  private updateSun(v: BodyVisual, r: number, camera: THREE.PerspectiveCamera, elapsed: number): void {
    if (this.sunMaterial) this.sunMaterial.uniforms.time.value = elapsed;
    const c = this.corona;
    if (!c) return;
    const extent = c.userData.extent as number;
    c.position.copy(v.scenePos);
    c.quaternion.copy(camera.quaternion);
    c.scale.setScalar(r * extent);
    const m = c.material as THREE.ShaderMaterial;
    m.uniforms.time.value = elapsed;
    // la corona è visibile solo se il Sole non è ridotto a un punto
    const px = r / Math.max(camera.position.distanceTo(v.scenePos), 1e-9);
    m.uniforms.intensity.value = THREE.MathUtils.clamp(px * 40, 0.25, 0.9);
  }

  /** Uniform di luce: Sole e occultatori in coordinate REALI, in raggi del corpo. */
  private updateLighting(v: BodyVisual, r: number, camera: THREE.PerspectiveCamera, t: number): void {
    const u = v.light;
    if (!u) return;
    const sim = this.sim;
    const b = v.body;
    const R = b.radius;
    const p = sim.position(b.id);
    const toScene = (x: number, y: number, z: number, out: THREE.Vector3) => ScaleManager.toThreeAxes(x / R, y / R, z / R, out);
    const sp = sim.position('sun').sub(p);
    toScene(sp.x, sp.y, sp.z, u.sunPos.value);
    u.sunRadius.value = sim.get('sun').radius / R;
    let n = 0;
    for (const id of v.occluders) {
      const o = sim.get(id);
      const d = sim.position(id).sub(p);
      const vec = u.occ.value[n] as THREE.Vector4;
      toScene(d.x, d.y, d.z, this.v3);
      vec.set(this.v3.x, this.v3.y, this.v3.z, o.radius / R);
      u.occAtm.value[n] = id === 'earth' ? 1 : 0;
      n++;
    }
    u.occCount.value = n;
    u.flatK.value = 1 - v.flattening;
    u.radiusScene.value = r;
    if (u.hasRings.value > 0.5 && bodyPole(sim, b.id, this.v3)) u.ringNormal.value.copy(this.v3);
    if (v.surface) {
      v.surface.uniforms.bodyCenter.value.copy(v.scenePos);
      v.surface.uniforms.camRel.value.subVectors(camera.position, v.scenePos);
      v.surface.uniforms.poleAxis.value.set(0, 1, 0).applyQuaternion(v.mesh.quaternion);
      (v.surface.uniforms.objRot.value as THREE.Matrix3).setFromMatrix4(this.m4.makeRotationFromQuaternion(v.mesh.quaternion));
      // le nubi scorrono lentamente verso est rispetto al suolo
      const off = ((t / 86400) / 45) % 1;
      v.surface.uniforms.cloudOffset.value = -off;
    }
    if (v.atmosphere) {
      const m = v.atmosphere.material as THREE.ShaderMaterial;
      const h = v.atmHeight ?? 0.02;
      m.uniforms.center.value.copy(v.scenePos);
      m.uniforms.rPlanet.value = r;
      m.uniforms.rAtm.value = r * (1 + h);
      m.uniforms.sunDir.value.copy(u.sunPos.value).normalize();
      m.uniforms.flatK.value = 1 - v.flattening;
      if (bodyPole(sim, b.id, this.v3)) m.uniforms.poleAxis.value.copy(this.v3);
      // eclissi: l'atmosfera si spegne con il Sole
      m.side = camera.position.distanceTo(v.scenePos) < r * (1 + h) ? THREE.BackSide : THREE.FrontSide;
    }
  }

  /**
   * Frazione di luce solare che arriva nel punto `p` (posizione reale nel frame del motore):
   * eclissi dei corpi vicini (dischi apparenti del Sole e dell'occultatore).
   */
  sunlightAt(p: Vec3, near: string[]): number {
    const sim = this.sim;
    const toS = sim.position('sun').sub(p);
    const dS = toS.length();
    const aS = Math.asin(Math.min(1, sim.get('sun').radius / dS));
    let light = 1;
    for (const id of near) {
      if (!sim.has(id)) continue;
      const toO = sim.position(id).sub(p);
      const dO = toO.length();
      const R = sim.get(id).radius;
      if (dO <= R || toO.dot(toS) <= 0) continue;
      const aO = Math.asin(Math.min(1, R / dO));
      const sep = Math.atan2(toO.cross(toS).length(), toO.dot(toS));
      const full = Math.min(1, (aO * aO) / (aS * aS));
      const lo = Math.abs(aS - aO);
      let cover = 0;
      if (sep <= lo) cover = full;
      else if (sep < aS + aO) {
        const t = (sep - lo) / (aS + aO - lo);
        cover = full * (1 - t * t * (3 - 2 * t));
      }
      light *= 1 - cover;
    }
    return light;
  }

  /** Ellissoide grafico di un corpo (per non far entrare la camera nel suolo). */
  obstacle(id: string): { center: THREE.Vector3; radius: number; pole: THREE.Vector3; flattening: number } | undefined {
    const v = this.visuals.get(id);
    if (!v) return undefined;
    return {
      center: v.scenePos,
      radius: v.baseRadius * this.scale.equatorialFactor(v.body),
      pole: new THREE.Vector3(0, 1, 0).applyQuaternion(v.mesh.quaternion),
      flattening: v.flattening,
    };
  }

  /** Sfere che possono coprire il Sole (per il riflesso dell'obiettivo). */
  *sunOccluders(): Generator<{ center: THREE.Vector3; radius: number }> {
    for (const v of this.ordered) if (v.body.kind !== 'star') yield { center: v.scenePos, radius: v.mesh.scale.x };
  }

  sunVisualRadius(): number {
    return this.visuals.get('sun')?.mesh.scale.x ?? 1;
  }

  private isLabelVisible(v: BodyVisual, focus: BodyVisual | undefined, camera: THREE.PerspectiveCamera): boolean {
    const b = v.body;
    if (b.kind !== 'moon') return true;
    if (!b.parentId) return true;
    if (this.focusId === b.id || this.focusId === b.parentId) return true;
    if (focus && focus.body.parentId === b.parentId) return true; // luna "sorella" agganciata
    const parent = this.visuals.get(b.parentId);
    if (!parent) return false;
    return camera.position.distanceTo(parent.scenePos) < this.focusDistance(parent.body.id) * 2.5;
  }

  private rebuildOrbit(v: BodyVisual): void {
    const o = v.orbit;
    if (!o) return;
    const sim = this.sim;
    const primary = sim.get(o.primaryId);
    let r: Vec3, vel: Vec3, mu: number;
    if (primary.kind === 'star') {
      // Orbita del baricentro del sistema (pianeta + lune) attorno al Sole
      const bc = sim.systemBarycenter(v.body.id);
      r = bc.r.sub(sim.position(primary.id));
      vel = bc.v.sub(sim.velocity(primary.id));
      mu = primary.gm + bc.gm;
    } else {
      const rel = sim.relativeState(v.body.id, primary.id);
      r = rel.r;
      vel = rel.v;
      mu = primary.gm + v.body.gm;
    }
    const el = stateToElements(r, vel, mu);
    if (!el.isBound) {
      o.line.visible = false;
      return;
    }
    o.line.visible = true;
    const pts = sampleOrbit(el, ORBIT_SAMPLES); // ORBIT_SAMPLES + 1 punti, l'ultimo = il primo
    const buf = new Float64Array(ORBIT_SAMPLES * 3);
    for (let k = 0; k < ORBIT_SAMPLES; k++) {
      if (primary.kind === 'star') this.scale.mapHeliocentric(pts[k], this.tmp);
      else this.scale.mapSatelliteOffset(pts[k], primary, this.tmp);
      buf[k * 3] = this.tmp.x;
      buf[k * 3 + 1] = this.tmp.y;
      buf[k * 3 + 2] = this.tmp.z;
    }
    lineRebaser.set(o.line, buf);
  }

  // ─────────────────────────── Informazioni per camera e picking ───────────────────────────

  scenePosition(id: string): THREE.Vector3 | undefined {
    return this.visuals.get(id)?.scenePos;
  }

  /** Sorgente per il Picker: sfere dei corpi naturali. */
  asPickSource(): PickSource {
    return {
      raycastTargets: () => this.pickableMeshes(),
      idOf: (obj) => this.bodyIdOf(obj),
      screenCandidates: () => this.ordered.map((v) => ({ id: v.body.id, pos: v.scenePos })),
    };
  }

  pickableMeshes(): THREE.Object3D[] {
    return this.ordered.map((v) => v.mesh);
  }

  bodyIdOf(obj: THREE.Object3D): string | undefined {
    return obj.userData.bodyId as string | undefined;
  }

  allVisuals(): readonly BodyVisual[] {
    return this.ordered;
  }

  /** Distanza di camera "comoda" per inquadrare un corpo (con le sue lune). */
  focusDistance(id: string): number {
    const v = this.visuals.get(id);
    if (!v) return 10;
    if (v.body.kind === 'star') return this.scale.radial(10 * AU) * 2.1;
    const R = this.scale.visualRadius(v.body);
    let d = R * 8;
    for (const m of this.ordered) {
      if (m.body.parentId !== id) continue;
      d = Math.max(d, m.scenePos.distanceTo(v.scenePos) * 2.6);
    }
    return Math.max(d, 1e-6);
  }

  /** Distanza minima di zoom (appena fuori dalla superficie grafica). */
  minDistance(id: string): number {
    const v = this.visuals.get(id);
    return v ? Math.max(this.scale.visualRadius(v.body) * 1.2, 1e-6) : 1e-6;
  }
}
