/**
 * ArtificialObjectsView — rappresentazione 3D degli oggetti artificiali.
 *  - marcatori a dimensione costante in pixel (THREE.Points) per gli oggetti in evidenza
 *  - etichette cliccabili
 *  - orbite kepleriane osculanti (satelliti e orbiter planetari), traiettoria tabulata JPL
 *    (punti lagrangiani) e traiettoria storica dal lancio (sonde interplanetarie)
 *  - nuvole di punti per i cataloghi CelesTrak
 * Le posizioni passano sempre dallo ScaleManager, come per i corpi naturali.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sampleOrbit, stateToElements } from '../physics/kepler.ts';
import type { Simulation } from '../physics/simulation.ts';
import type { Vec3 } from '../physics/vec3.ts';
import { Vec3 as V3 } from '../physics/vec3.ts';
import type { ArtificialObject, ArtificialObjects } from '../spacecraft/ArtificialObjects.ts';
import type { SatelliteGroups } from '../spacecraft/SatelliteGroups.ts';
import type { SmallBodyGroups } from '../spacecraft/SmallBodyGroups.ts';
import { AU } from '../physics/constants.ts';
import { keplerianSystemState } from '../physics/initialState.ts';
import type { PickCandidate, PickSource } from './Picker.ts';
import { ScaleManager } from './ScaleManager.ts';
import type { SolarSystemView } from './SolarSystemView.ts';
import { SpacecraftModel } from './spacecraftModels.ts';
import { lineRebaser } from './precision.ts';

const ORBIT_SAMPLES = 180;
const LINE_REFRESH = 0.25;

interface ObjectVisual {
  obj: ArtificialObject;
  scenePos: THREE.Vector3;
  anchor: THREE.Object3D;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  /** Orbita (LineLoop) o traiettoria tabulata (Line), agganciata al centro. */
  orbitGroup: THREE.Group;
  orbitLine: THREE.Line | null;
  orbitIsLoop: boolean;
  historyLine: THREE.Line | null;
  historyCount: number;
  /**
   * Corpo rispetto al quale l'oggetto è disegnato. Di solito il centro del catalogo; per una sonda
   * eliocentrica che passa dentro la sfera d'influenza di un pianeta (es. un flyby) è quel pianeta,
   * così nella scala logaritmica appare nel posto giusto rispetto al pianeta.
   */
  effCenter: string;
  effRel: Vec3;
  /** Modello 3D (creato quando la camera si avvicina). */
  model?: SpacecraftModel;
  modelKey?: string;
  /** Il modello è abbastanza grande a video da sostituire il marcatore. */
  modelBig: boolean;
  /** La traiettoria storica contiene il punto attuale (da ricalcolare anche quando non è più inquadrato). */
  historyThrough?: boolean;
}

/** Indice del vertice più vicino a p (polilinea in float64, n punti). */
function nearestVertex(a: Float64Array, n: number, p: THREE.Vector3): number {
  let best = Infinity;
  let k = -1;
  for (let i = 0; i < n; i++) {
    const d = (a[i * 3] - p.x) ** 2 + (a[i * 3 + 1] - p.y) ** 2 + (a[i * 3 + 2] - p.z) ** 2;
    if (d < best) {
      best = d;
      k = i;
    }
  }
  return k;
}

/** Dove inserire p in una polilinea: dopo il vertice più vicino se p sta sul segmento successivo. */
function insertionIndex(a: Float64Array, n: number, p: THREE.Vector3): number {
  const k = nearestVertex(a, n, p);
  if (k < 0) return 0;
  if (k === n - 1) {
    // oltre l'ultimo punto o appena prima?
    if (n < 2) return n;
    const dx = a[k * 3] - a[(k - 1) * 3], dy = a[k * 3 + 1] - a[(k - 1) * 3 + 1], dz = a[k * 3 + 2] - a[(k - 1) * 3 + 2];
    const t = (p.x - a[k * 3]) * dx + (p.y - a[k * 3 + 1]) * dy + (p.z - a[k * 3 + 2]) * dz;
    return t > 0 ? n : k;
  }
  const dx = a[(k + 1) * 3] - a[k * 3], dy = a[(k + 1) * 3 + 1] - a[k * 3 + 1], dz = a[(k + 1) * 3 + 2] - a[k * 3 + 2];
  const t = (p.x - a[k * 3]) * dx + (p.y - a[k * 3 + 1]) * dy + (p.z - a[k * 3 + 2]) * dz;
  return t > 0 ? k + 1 : k;
}

interface CloudVisual {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  version: number;
  scaleVersion: number;
}

function markerTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 9, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function dotTexture(): THREE.Texture {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

export class ArtificialObjectsView {
  readonly root = new THREE.Group();
  focusId = '';
  showOrbits = true;
  showLabels = true;
  onLabelClick: (id: string) => void = () => {};

  private readonly objects: ArtificialObjects;
  private readonly groups: SatelliteGroups;
  private readonly smallBodies: SmallBodyGroups | null;
  private readonly sbClouds = new Map<string, CloudVisual>();
  private readonly sbRoot = new THREE.Group();
  private readonly sim: Simulation;
  private readonly scale: ScaleManager;
  private readonly natural: SolarSystemView;
  private readonly visuals = new Map<string, ObjectVisual>();
  private readonly clouds = new Map<string, CloudVisual>();
  private readonly markers: THREE.Points;
  private readonly markerGeo = new THREE.BufferGeometry();
  private readonly focusMarker: THREE.Points;
  private readonly dotTex = dotTexture();
  private readonly cloudRoot = new THREE.Group();
  private lineClock = Infinity;
  private lastScaleVersion = -1;
  private readonly tmp = new THREE.Vector3();

  constructor(
    objects: ArtificialObjects,
    groups: SatelliteGroups,
    sim: Simulation,
    scale: ScaleManager,
    natural: SolarSystemView,
    scene: THREE.Scene,
    pixelRatio: number,
    smallBodies: SmallBodyGroups | null = null,
  ) {
    this.objects = objects;
    this.groups = groups;
    this.smallBodies = smallBodies;
    this.sim = sim;
    this.scale = scale;
    this.natural = natural;
    scene.add(this.root);
    this.root.add(this.cloudRoot);
    this.root.add(this.sbRoot); // corpi minori: eliocentrici, il Sole è nell'origine della scena

    const tex = markerTexture();
    this.markers = new THREE.Points(
      this.markerGeo,
      new THREE.PointsMaterial({
        size: 11 * pixelRatio, sizeAttenuation: false, map: tex, vertexColors: true,
        transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.05,
      }),
    );
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 5;
    this.root.add(this.markers);

    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.focusMarker = new THREE.Points(
      fg,
      new THREE.PointsMaterial({
        size: 22 * pixelRatio, sizeAttenuation: false, map: tex, color: 0x6fb6ff,
        transparent: true, depthTest: false, depthWrite: false,
      }),
    );
    this.focusMarker.frustumCulled = false;
    this.focusMarker.renderOrder = 6;
    this.root.add(this.focusMarker);
  }

  // ───────────────────────── Gestione visuali ─────────────────────────

  private visualFor(o: ArtificialObject): ObjectVisual {
    let v = this.visuals.get(o.def.id);
    if (v) return v;
    const el = document.createElement('div');
    el.className = `body-label kind-artificial cat-${o.def.category}`;
    el.textContent = o.def.name;
    el.style.setProperty('--body-color', o.color);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onLabelClick(o.def.id);
    });
    const anchor = new THREE.Object3D();
    const label = new CSS2DObject(el);
    label.center.set(-0.08, 0.5); // a destra del marcatore
    anchor.add(label);
    this.root.add(anchor);
    const orbitGroup = new THREE.Group();
    this.root.add(orbitGroup);
    v = {
      obj: o, scenePos: new THREE.Vector3(), anchor, label, labelEl: el, orbitGroup,
      orbitLine: null, orbitIsLoop: false, historyLine: null, historyCount: 0,
      effCenter: o.def.center, effRel: o.rel, modelBig: false,
    };
    this.visuals.set(o.def.id, v);
    return v;
  }

  private dispose(v: ObjectVisual): void {
    v.anchor.removeFromParent();
    v.label.element.remove();
    v.orbitGroup.removeFromParent();
    v.orbitLine?.geometry.dispose();
    v.historyLine?.geometry.dispose();
    v.historyLine?.removeFromParent();
    v.model?.dispose();
    this.visuals.delete(v.obj.def.id);
  }

  /** Posizione in scena di un oggetto relativo al centro `centerId`. */
  private mapRelative(centerId: string, rel: Vec3, out: THREE.Vector3): THREE.Vector3 {
    const centerScene = this.natural.scenePosition(centerId) ?? this.tmp.set(0, 0, 0);
    const center = this.sim.get(centerId);
    if (center.kind === 'star') return this.scale.mapHeliocentric(rel, out).add(centerScene);
    return this.scale.mapSatelliteOffset(rel, center, out).add(centerScene);
  }

  private mapOffset(centerId: string, rel: Vec3, out: THREE.Vector3): THREE.Vector3 {
    const center = this.sim.get(centerId);
    return center.kind === 'star' ? this.scale.mapHeliocentric(rel, out) : this.scale.mapSatelliteOffset(rel, center, out);
  }

  /** Sceglie il corpo di riferimento per il disegno (vedi ObjectVisual.effCenter). */
  private resolveCenter(v: ObjectVisual): void {
    const o = v.obj;
    v.effCenter = o.def.center;
    v.effRel = o.rel;
    if (o.def.center !== 'sun') return;
    const abs = this.sim.position('sun').add(o.rel);
    for (const b of this.sim.bodies) {
      if ((b.kind !== 'planet' && b.kind !== 'dwarf') || !Number.isFinite(b.soi)) continue;
      const rel = abs.sub(this.sim.position(b.id));
      if (rel.length() < b.soi) {
        v.effCenter = b.id;
        v.effRel = rel;
        return;
      }
    }
  }

  // ───────────────────────── Aggiornamento per frame ─────────────────────────

  update(camera: THREE.PerspectiveCamera, realDt: number): void {
    const active: ObjectVisual[] = [];
    for (const o of this.objects.list()) {
      const shown = o.visible && o.valid;
      const existing = this.visuals.get(o.def.id);
      if (!shown) {
        if (existing) {
          existing.anchor.visible = false;
          existing.orbitGroup.visible = false;
          if (existing.historyLine) existing.historyLine.visible = false;
          if (!o.visible) this.dispose(existing);
        }
        continue;
      }
      const v = existing ?? this.visualFor(o);
      this.resolveCenter(v);
      this.mapRelative(v.effCenter, v.effRel, v.scenePos);
      v.anchor.position.copy(v.scenePos);
      v.anchor.visible = true;
      v.orbitGroup.position.copy(this.natural.scenePosition(o.def.center) ?? this.tmp.set(0, 0, 0));
      this.updateModel(v, camera);
      active.push(v);
    }
    const markerList = active.filter((v) => !v.modelBig);

    // Marcatori (non per gli oggetti di cui si vede già il modello 3D)
    const n = markerList.length;
    let attr = this.markerGeo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr || attr.count !== n) {
      this.markerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this.markerGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      attr = this.markerGeo.getAttribute('position') as THREE.BufferAttribute;
    }
    const col = this.markerGeo.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    markerList.forEach((v, i) => {
      attr!.setXYZ(i, v.scenePos.x, v.scenePos.y, v.scenePos.z);
      c.set(v.obj.color);
      col.setXYZ(i, c.r, c.g, c.b);
    });
    attr.needsUpdate = true;
    col.needsUpdate = true;
    this.markerGeo.computeBoundingSphere();

    const focus = this.visuals.get(this.focusId);
    this.focusMarker.visible = !!focus && focus.anchor.visible && !focus.modelBig;
    if (focus) {
      const fp = this.focusMarker.geometry.getAttribute('position') as THREE.BufferAttribute;
      fp.setXYZ(0, focus.scenePos.x, focus.scenePos.y, focus.scenePos.z);
      fp.needsUpdate = true;
    }

    // Linee (ricalcolo periodico o al cambio di scala)
    this.lineClock += realDt;
    const scaleChanged = this.lastScaleVersion !== this.scale.version;
    if (scaleChanged || this.lineClock >= LINE_REFRESH) {
      this.lineClock = 0;
      for (const v of active) this.rebuildLines(v, scaleChanged);
    } else if (focus && focus.anchor.visible) {
      // l'oggetto inquadrato: linee aggiornate a ogni frame, così restano agganciate al modello
      this.rebuildLines(focus, false);
    }
    this.lastScaleVersion = this.scale.version;
    for (const v of active) {
      v.orbitGroup.visible = this.showOrbits;
      if (v.historyLine) v.historyLine.visible = this.showOrbits;
      const focused = v.obj.def.id === this.focusId;
      const mat = v.orbitLine?.material as THREE.LineBasicMaterial | undefined;
      if (mat) mat.opacity = focused ? 0.9 : 0.35;
      const hmat = v.historyLine?.material as THREE.LineBasicMaterial | undefined;
      if (hmat) hmat.opacity = focused ? 0.8 : 0.22;
      v.label.visible = this.showLabels && this.labelVisible(v, camera);
      v.labelEl.classList.toggle('focused', focused);
    }

    this.updateClouds();
    this.updateSmallBodies();
  }

  /** Metri → unità di scena vicino al corpo `centerId` (stesso ingrandimento del corpo). */
  metersToScene(centerId: string): number {
    if (this.scale.mode === 'real') return 1 / this.scale.settings.realUnit;
    const c = this.sim.get(centerId);
    return this.scale.visualRadius(c) / c.radius;
  }

  /** Diametro [km] di un corpo minore: dal SBDB o stimato dalla magnitudine assoluta H. */
  private smallBodyDiameter(o: ArtificialObject): number | undefined {
    const ph = o.phys?.phys;
    if (!ph) return undefined;
    const d = Number(ph.diameter?.value);
    if (Number.isFinite(d) && d > 0) return d;
    const H = Number(ph.H?.value);
    const albedo = Number(ph.albedo?.value) || 0.14;
    return Number.isFinite(H) ? (1329 / Math.sqrt(albedo)) * Math.pow(10, -H / 5) : undefined;
  }

  private updateModel(v: ObjectVisual, camera: THREE.PerspectiveCamera): void {
    const o = v.obj;
    const small = o.def.category === 'asteroid' || o.def.category === 'tno';
    const key = small ? `d${this.smallBodyDiameter(o) ?? 0}` : 'm';
    const k = this.metersToScene(v.effCenter);
    const guessSize = small ? (this.smallBodyDiameter(o) ?? 1) * 1000 : v.model?.size ?? 10;
    const dist = camera.position.distanceTo(v.scenePos);
    const near = dist < guessSize * k * 3000 || o.def.id === this.focusId;
    if (!near) {
      if (v.model) v.model.group.visible = false;
      v.modelBig = false;
      return;
    }
    if (!v.model || v.modelKey !== key) {
      v.model?.dispose();
      v.model = new SpacecraftModel(o.def.id, { category: o.def.category, diameterKm: this.smallBodyDiameter(o) });
      v.modelKey = key;
      this.root.add(v.model.group);
    }
    const m = v.model;
    const sceneSize = m.size * k;
    const px = (sceneSize / Math.max(dist, 1e-12)) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 900;
    m.group.visible = px > 2;
    v.modelBig = px > 14;
    m.group.position.copy(v.scenePos);
    m.group.scale.setScalar(k);
    this.orient(v, m.group);
  }

  /** Assetto: in orbita attorno a un corpo +Y verso lo zenit e +Z lungo la velocità; nello spazio profondo +Y verso la Terra. */
  private orient(v: ObjectVisual, g: THREE.Object3D): void {
    const o = v.obj;
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    if (o.def.category === 'asteroid' || o.def.category === 'tno') {
      // rotazione lenta attorno a un asse fisso
      g.rotation.set(0.4, (this.sim.time / 3600) % (2 * Math.PI), 0.2);
      return;
    }
    if (o.def.center === 'sun') {
      const toEarth = this.sim.position('earth').sub(this.sim.position('sun').add(o.rel));
      ScaleManager.toThreeAxes(toEarth.x, toEarth.y, toEarth.z, up).normalize();
      ScaleManager.toThreeAxes(o.vel.x, o.vel.y, o.vel.z, fwd).normalize();
    } else {
      ScaleManager.toThreeAxes(o.rel.x, o.rel.y, o.rel.z, up).normalize();
      ScaleManager.toThreeAxes(o.vel.x, o.vel.y, o.vel.z, fwd).normalize();
    }
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-9) fwd.set(1, 0, 0).addScaledVector(up, -up.x);
    fwd.normalize();
    const x = new THREE.Vector3().crossVectors(up, fwd);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, fwd));
  }

  /** Nuvole di asteroidi (posizioni eliocentriche in AU dal worker). */
  private updateSmallBodies(): void {
    if (!this.smallBodies) return;
    const rel = new V3();
    for (const g of this.smallBodies.groups.values()) {
      let cv = this.sbClouds.get(g.def.id);
      if (!g.visible || !g.positions) {
        if (cv) cv.points.visible = false;
        continue;
      }
      const n = g.positions.length / 3;
      if (!cv || (cv.geometry.getAttribute('position') as THREE.BufferAttribute).count !== n) {
        if (cv) {
          cv.geometry.dispose();
          cv.points.removeFromParent();
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({
          size: 2.2, sizeAttenuation: false, color: new THREE.Color(g.def.color), map: this.dotTex,
          transparent: true, depthWrite: false, opacity: 0.75,
        }));
        points.frustumCulled = false;
        this.sbRoot.add(points);
        cv = { points, geometry, version: -1, scaleVersion: -1 };
        this.sbClouds.set(g.def.id, cv);
      }
      cv.points.visible = true;
      if (cv.version === g.version && cv.scaleVersion === this.scale.version) continue;
      const attr = cv.geometry.getAttribute('position') as THREE.BufferAttribute;
      const src = g.positions;
      for (let i = 0; i < n; i++) {
        const x = src[i * 3];
        if (Number.isNaN(x)) {
          attr.setXYZ(i, 0, 0, 0);
          continue;
        }
        rel.x = x * AU;
        rel.y = src[i * 3 + 1] * AU;
        rel.z = src[i * 3 + 2] * AU;
        this.scale.mapHeliocentric(rel, this.tmp);
        attr.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      }
      attr.needsUpdate = true;
      cv.version = g.version;
      cv.scaleVersion = this.scale.version;
    }
  }

  /** Punti dei cataloghi di asteroidi: id "sb:<gruppo>:<indice>". */
  smallBodyPickSource(): PickSource {
    const self = this;
    return {
      priority: true,
      *screenCandidates() {
        if (!self.smallBodies) return;
        const p = new THREE.Vector3();
        for (const g of self.smallBodies.groups.values()) {
          const cv = self.sbClouds.get(g.def.id);
          if (!g.visible || !cv || !cv.points.visible) continue;
          const attr = cv.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < attr.count; i++) {
            const x = attr.getX(i);
            if (x === 0 && attr.getY(i) === 0) continue;
            p.set(x, attr.getY(i), attr.getZ(i));
            yield { id: `sb:${g.def.id}:${i}`, pos: p };
          }
        }
      },
    };
  }

  private labelVisible(v: ObjectVisual, camera: THREE.PerspectiveCamera): boolean {
    const o = v.obj;
    if (o.def.id === this.focusId) return true;
    if (v.effCenter === 'sun') return true;
    if (this.focusId === v.effCenter) return true;
    const center = this.natural.scenePosition(v.effCenter);
    if (!center) return false;
    return camera.position.distanceTo(center) < this.natural.focusDistance(v.effCenter) * 2.5;
  }

  private rebuildLines(v: ObjectVisual, scaleChanged: boolean): void {
    const o = v.obj;
    const centerId = o.def.center;
    const center = this.sim.get(centerId);

    // Traiettoria storica (eliocentrica): ricalcolata al cambio di scala, all'arrivo dei dati e, per
    // l'oggetto inquadrato, a ogni aggiornamento (la linea deve passare esattamente per la sonda)
    const focused = o.def.id === this.focusId;
    if (o.history && o.history.length > 1 && (scaleChanged || v.historyCount !== o.history.length || focused || v.historyThrough)) {
      const pts = o.history;
      const n0 = pts.length;
      const raw = new Float64Array(n0 * 3);
      const start = this.natural.scenePosition(centerId) ?? new THREE.Vector3();
      pts.forEach((p, i) => {
        this.mapOffset(centerId, p, this.tmp).add(start);
        raw.set([this.tmp.x, this.tmp.y, this.tmp.z], i * 3);
      });
      // il punto attuale entra nella polilinea (altrimenti una corda lunga passa lontano dalla sonda)
      let pos = raw;
      let at = -1;
      if (focused && v.effCenter === centerId) {
        this.mapRelative(centerId, o.rel, this.tmp);
        at = insertionIndex(raw, n0, this.tmp);
        pos = new Float64Array((n0 + 1) * 3);
        pos.set(raw.subarray(0, at * 3), 0);
        pos.set([this.tmp.x, this.tmp.y, this.tmp.z], at * 3);
        pos.set(raw.subarray(at * 3), (at + 1) * 3);
      }
      v.historyThrough = at >= 0;
      const n = pos.length / 3;
      const colors = new Float32Array(n * 3);
      const base = new THREE.Color(o.color);
      for (let i = 0; i < n; i++) {
        const k = 0.25 + 0.75 * (i / (n - 1)); // più tenue verso il passato
        colors.set([base.r * k, base.g * k, base.b * k], i * 3);
      }
      if (!v.historyLine) {
        v.historyLine = new THREE.Line(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false }),
        );
        v.historyLine.frustumCulled = false;
        this.root.add(v.historyLine);
      }
      const cur = v.historyLine.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!cur || cur.count !== n) {
        v.historyLine.geometry.dispose();
        v.historyLine.geometry = new THREE.BufferGeometry();
        v.historyLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        v.historyLine.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      } else {
        (v.historyLine.geometry.getAttribute('color') as THREE.BufferAttribute).copyArray(colors).needsUpdate = true;
      }
      lineRebaser.set(v.historyLine, pos);
      v.historyCount = pts.length;
    }
    if (o.history && centerId === 'sun') {
      // Per le sonde eliocentriche la storia basta: niente orbita osculante
      if (v.orbitLine) v.orbitLine.visible = false;
      return;
    }

    // Orbita: tabella JPL (punti lagrangiani) oppure ellisse kepleriana osculante
    let points: V3[] | null = null;
    let loop = false;
    if (o.def.category === 'lagrange' && o.table) {
      // Orbita di alone vista nel sistema rotante Sole–Terra (come nelle animazioni NASA/ESA):
      // ogni punto viene espresso negli assi Sole→Terra del proprio istante e riportato agli assi di oggi.
      const earthDef = this.sim.get('earth').def!;
      const axes = (t: number) => {
        const st = keplerianSystemState(this.sim.catalog, earthDef, t);
        const x = st.r.normalize();
        const z = st.r.cross(st.v).normalize();
        return { x, y: z.cross(x), z };
      };
      const now = axes(this.sim.time);
      points = o.table.points.map((p) => {
        const a = axes(p.t);
        const cx = p.r.dot(a.x), cy = p.r.dot(a.y), cz = p.r.dot(a.z);
        return now.x.scale(cx).add(now.y.scale(cy)).add(now.z.scale(cz));
      });
    } else if (center.gm > 0) {
      const el = stateToElements(o.rel, o.vel, center.gm);
      if (el.isBound) {
        points = sampleOrbit(el, ORBIT_SAMPLES).slice(0, ORBIT_SAMPLES);
        loop = true;
      } else {
        points = sampleOrbit(el, ORBIT_SAMPLES, Math.max(o.rel.length() * 3, center.radius * 20));
      }
    }
    if (!points || points.length < 2) {
      if (v.orbitLine) v.orbitLine.visible = false;
      return;
    }
    if (!v.orbitLine || v.orbitIsLoop !== loop || (v.orbitLine.geometry.getAttribute('position') as THREE.BufferAttribute).count !== points.length) {
      if (v.orbitLine) {
        v.orbitLine.geometry.dispose();
        v.orbitLine.removeFromParent();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points.length * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(o.color), transparent: true, opacity: 0.35, depthWrite: false });
      v.orbitLine = loop ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
      v.orbitLine.frustumCulled = false;
      v.orbitIsLoop = loop;
      v.orbitGroup.add(v.orbitLine);
    }
    const buf = new Float64Array(points.length * 3);
    points.forEach((p, i) => {
      this.mapOffset(centerId, p, this.tmp);
      buf[i * 3] = this.tmp.x;
      buf[i * 3 + 1] = this.tmp.y;
      buf[i * 3 + 2] = this.tmp.z;
    });
    // il vertice più vicino diventa la posizione esatta dell'oggetto: la linea passa per il modello 3D
    this.mapOffset(centerId, o.rel, this.tmp);
    const k = nearestVertex(buf, points.length, this.tmp);
    if (k >= 0) buf.set([this.tmp.x, this.tmp.y, this.tmp.z], k * 3);
    lineRebaser.set(v.orbitLine, buf);
    v.orbitLine.visible = true;
  }

  private updateClouds(): void {
    const earth = this.natural.scenePosition('earth');
    if (earth) this.cloudRoot.position.copy(earth);
    const earthBody = this.sim.get('earth');
    const rel = new V3();
    for (const g of this.groups.groups.values()) {
      let cv = this.clouds.get(g.def.id);
      if (!g.visible || !g.positions) {
        if (cv) cv.points.visible = false;
        continue;
      }
      const n = g.positions.length / 3;
      if (!cv || (cv.geometry.getAttribute('position') as THREE.BufferAttribute).count !== n) {
        if (cv) {
          cv.geometry.dispose();
          cv.points.removeFromParent();
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        const points = new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            size: 3, sizeAttenuation: false, color: new THREE.Color(g.def.color), map: this.dotTex,
            transparent: true, depthWrite: false, opacity: 0.9,
          }),
        );
        points.frustumCulled = false;
        this.cloudRoot.add(points);
        cv = { points, geometry, version: -1, scaleVersion: -1 };
        this.clouds.set(g.def.id, cv);
      }
      cv.points.visible = true;
      if (cv.version === g.version && cv.scaleVersion === this.scale.version) continue;
      const attr = cv.geometry.getAttribute('position') as THREE.BufferAttribute;
      const src = g.positions;
      for (let i = 0; i < n; i++) {
        const x = src[i * 3];
        if (Number.isNaN(x)) {
          attr.setXYZ(i, 0, 0, 0); // posizione non valida: nascosto al centro della Terra
          continue;
        }
        rel.x = x * 1e3;
        rel.y = src[i * 3 + 1] * 1e3;
        rel.z = src[i * 3 + 2] * 1e3;
        this.scale.mapSatelliteOffset(rel, earthBody, this.tmp);
        attr.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      }
      attr.needsUpdate = true;
      cv.version = g.version;
      cv.scaleVersion = this.scale.version;
    }
  }

  // ───────────────────────── Camera e picking ─────────────────────────

  has(id: string): boolean {
    return this.visuals.has(id);
  }

  scenePosition(id: string): THREE.Vector3 | undefined {
    const v = this.visuals.get(id);
    return v && v.anchor.visible ? v.scenePos : undefined;
  }

  focusDistance(id: string): number {
    const v = this.visuals.get(id);
    if (!v) return 10;
    // primo piano sul modello 3D (con il pianeta sullo sfondo); con la rotella si torna alla vista d'insieme
    if (!v.model) {
      const o = v.obj;
      v.model = new SpacecraftModel(o.def.id, { category: o.def.category, diameterKm: this.smallBodyDiameter(o) });
      v.modelKey = o.def.category === 'asteroid' || o.def.category === 'tno' ? `d${this.smallBodyDiameter(o) ?? 0}` : 'm';
      this.root.add(v.model.group);
    }
    return v.model.size * this.metersToScene(v.effCenter) * 3.2;
  }

  /** Distanza per la vista d'insieme (oggetto con la sua orbita e il corpo centrale). */
  overviewDistance(id: string): number {
    const v = this.visuals.get(id);
    if (!v) return 10;
    const center = this.sim.get(v.effCenter);
    if (center.kind === 'star') return this.scale.mode === 'log' ? 30 : 15;
    const R = this.scale.visualRadius(center);
    const off = this.mapOffset(v.effCenter, v.effRel, this.tmp).length();
    return Math.max(R * 0.9, off * 0.35);
  }

  minDistance(id?: string): number {
    const v = id ? this.visuals.get(id) : undefined;
    if (v?.model) return v.model.size * this.metersToScene(v.effCenter) * 0.7;
    return 1e-9;
  }

  /**
   * Per gli oggetti attorno a un pianeta: camera di fianco all'oggetto e poco sopra, così nel primo
   * piano il pianeta riempie la parte bassa dell'inquadratura con l'orizzonte.
   */
  focusDirection(id: string): THREE.Vector3 | undefined {
    const v = this.visuals.get(id);
    if (!v || v.effCenter === 'sun') return undefined;
    const center = this.natural.scenePosition(v.effCenter);
    if (!center) return undefined;
    const radial = v.scenePos.clone().sub(center).normalize();
    const vel = ScaleManager.toThreeAxes(v.obj.vel.x, v.obj.vel.y, v.obj.vel.z, new THREE.Vector3());
    if (!v.model || vel.lengthSq() === 0) return radial.add(new THREE.Vector3(0, 0.6, 0)).normalize();
    vel.addScaledVector(radial, -vel.dot(radial)).normalize();
    const side = new THREE.Vector3().crossVectors(radial, vel);
    return side.multiplyScalar(0.8).addScaledVector(radial, 0.35).addScaledVector(vel, -0.55).normalize();
  }

  /** Il pianeta attorno a cui orbita l'oggetto (la camera non deve entrarci). */
  avoid(id: string): ReturnType<SolarSystemView["obstacle"]> {
    const v = this.visuals.get(id);
    if (!v || v.effCenter === 'sun') return undefined;
    return this.natural.obstacle(v.effCenter);
  }

  /** Marcatori degli oggetti in evidenza (prioritari nel picking). */
  markerPickSource(): PickSource {
    return {
      priority: true,
      screenCandidates: () => {
        const out: PickCandidate[] = [];
        for (const v of this.visuals.values()) if (v.anchor.visible) out.push({ id: v.obj.def.id, pos: v.scenePos });
        return out;
      },
    };
  }

  /** Punti dei cataloghi CelesTrak: id "norad:<numero>". */
  cloudPickSource(): PickSource {
    const self = this;
    return {
      priority: true,
      *screenCandidates() {
        const earth = self.natural.scenePosition('earth');
        if (!earth) return;
        const p = new THREE.Vector3();
        for (const g of self.groups.groups.values()) {
          const cv = self.clouds.get(g.def.id);
          if (!g.visible || !cv || !cv.points.visible) continue;
          const attr = cv.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < attr.count; i++) {
            const x = attr.getX(i);
            if (Number.isNaN(x) || (x === 0 && attr.getY(i) === 0 && attr.getZ(i) === 0)) continue;
            p.set(x, attr.getY(i), attr.getZ(i)).add(earth);
            yield { id: `norad:${g.omms[i]?.NORAD_CAT_ID}`, pos: p };
          }
        }
      },
    };
  }
}
