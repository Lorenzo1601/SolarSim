/**
 * LaunchView — il veicolo lanciato nella scena: marcatore, etichetta, scia della traiettoria percorsa
 * (relativa al corpo dominante di ogni tratto), orbita/traiettoria prevista (conica osculante) e
 * rampa di lancio sulla superficie terrestre.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sampleOrbit, stateToElements } from '../physics/kepler.ts';
import type { Simulation } from '../physics/simulation.ts';
import { Vec3 } from '../physics/vec3.ts';
import type { LaunchMission } from '../launch/mission.ts';
import type { PickSource } from './Picker.ts';
import type { ScaleManager } from './ScaleManager.ts';
import type { SolarSystemView } from './SolarSystemView.ts';
import { ExhaustPlume, RocketModel } from './spacecraftModels.ts';
import { lineRebaser } from './precision.ts';
import type { EarthTiles } from './earthTiles.ts';
import { ScaleManager as SM } from './ScaleManager.ts';

export const LAUNCH_ID = 'launch-vehicle';

export class LaunchView {
  readonly root = new THREE.Group();
  mission: LaunchMission | null = null;
  focused = false;
  private readonly sim: Simulation;
  private readonly scale: ScaleManager;
  private readonly natural: SolarSystemView;
  private readonly marker: THREE.Points;
  private readonly label: CSS2DObject;
  private readonly labelEl: HTMLDivElement;
  private readonly anchor = new THREE.Object3D();
  private trail: THREE.Line;
  private readonly predicted: THREE.Line;
  private readonly predictedGroup = new THREE.Group();
  readonly scenePos = new THREE.Vector3();
  private dominant = 'earth';
  private clock = Infinity;
  private tmp = new THREE.Vector3();
  onLabelClick: () => void = () => {};
  /** Superficie ad alta risoluzione: il razzo in rampa viene appoggiato sul terreno. */
  earthTiles: EarthTiles | null = null;
  private padOffset = 0;
  private model: RocketModel | null = null;
  private readonly plume = new ExhaustPlume();
  private readonly timer = new THREE.Timer();
  private modelBig = false;
  private readonly camRef: { camera: THREE.PerspectiveCamera | null } = { camera: null };

  constructor(sim: Simulation, scale: ScaleManager, natural: SolarSystemView, scene: THREE.Scene, pixelRatio: number) {
    this.sim = sim;
    this.scale = scale;
    this.natural = natural;
    scene.add(this.root);
    this.root.visible = false;

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(32, 4);
    ctx.lineTo(56, 58);
    ctx.lineTo(32, 46);
    ctx.lineTo(8, 58);
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.marker = new THREE.Points(g, new THREE.PointsMaterial({
      size: 16 * pixelRatio, sizeAttenuation: false, map: tex, color: 0xff7a3d, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.marker.frustumCulled = false;
    this.marker.renderOrder = 8;
    this.root.add(this.marker);

    this.labelEl = document.createElement('div');
    this.labelEl.className = 'body-label kind-launch';
    this.labelEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.labelEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onLabelClick();
    });
    this.label = new CSS2DObject(this.labelEl);
    this.label.center.set(-0.1, 0.5);
    this.anchor.add(this.label);
    this.root.add(this.anchor);

    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff9a5c, transparent: true, opacity: 0.9, depthWrite: false }));
    this.trail.frustumCulled = false;
    this.root.add(this.trail);

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(361 * 3), 3));
    this.predicted = new THREE.Line(pg, new THREE.LineDashedMaterial({ color: 0xffd0a0, dashSize: 0.4, gapSize: 0.3, transparent: true, opacity: 0.6, depthWrite: false }));
    this.predicted.frustumCulled = false;
    this.predictedGroup.add(this.predicted);
    this.root.add(this.predictedGroup);
  }

  setMission(m: LaunchMission | null): void {
    this.mission = m;
    this.root.visible = !!m;
    this.model?.group.removeFromParent();
    this.model = null;
    if (m) {
      this.labelEl.textContent = `${m.cfg.rocket.name} · ${m.cfg.payload.name}`;
      const r = m.cfg.rocket;
      const boosters = r.stages.filter((st) => st.parallel).reduce((a, st) => a + st.count, 0);
      this.model = new RocketModel(r.id, r.diameter, boosters);
      this.model.setStage('full');
      this.root.add(this.model.group);
      this.model.group.add(this.plume.mesh);
    }
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camRef.camera = camera;
  }

  /** Metri → unità di scena vicino al corpo dominante. */
  private metersToScene(): number {
    if (this.scale.mode === 'real') return 1 / this.scale.settings.realUnit;
    const b = this.sim.get(this.dominant);
    return this.scale.visualRadius(b) / b.radius;
  }

  private updateModel(m: LaunchMission): void {
    const model = this.model;
    const cam = this.camRef.camera;
    if (!model || !cam) return;
    model.setStage(m.payloadSeparated ? 'payload' : m.phase === 'countdown' || m.phase === 'ascent' ? 'full' : 'upper');
    const k = this.metersToScene();
    const size = model.size * k;
    const dist = cam.position.distanceTo(this.scenePos);
    const px = size / Math.max(dist, 1e-12) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * 900;
    model.group.visible = px > 1.5;
    this.modelBig = px > 14;
    (this.marker.material as THREE.PointsMaterial).opacity = this.modelBig ? 0 : 1;
    model.group.position.copy(this.scenePos);
    model.group.scale.setScalar(k);
    // in rampa la base del razzo poggia sul suolo reale (rilievo); dopo il decollo la correzione
    // (pochi metri) sfuma in 40 s e resta la quota calcolata dalla fisica
    const cs = this.natural.scenePosition('earth');
    if (cs && this.dominant === 'earth') {
      const radial = this.tmp.copy(this.scenePos).sub(cs);
      const rNow = radial.length();
      if (m.phase === 'countdown') {
        const ground = this.earthTiles?.groundRadius(this.scenePos);
        this.padOffset = ground && rNow > 0 ? ground - rNow : 0;
      }
      const met = this.sim.time - m.cfg.launchTime;
      const fade = Math.min(1, Math.max(0, 1 - met / 40));
      if (this.padOffset !== 0 && fade > 0 && rNow > 0) model.group.position.addScaledVector(radial.normalize(), this.padOffset * fade);
    }
    // assetto: asse del razzo lungo la velocità rispetto alla Terra (in rampa: verticale)
    const e = this.sim.position(this.dominant);
    const ev = this.sim.velocity(this.dominant);
    const rel = m.position.sub(e);
    const vel = m.velocity.sub(ev);
    const up = SM.toThreeAxes(rel.x, rel.y, rel.z, new THREE.Vector3()).normalize();
    const along = SM.toThreeAxes(vel.x, vel.y, vel.z, new THREE.Vector3());
    let axis = up;
    if (m.phase === 'ascent' && this.dominant === 'earth') {
      // la velocità propria della rampa (rotazione terrestre) non conta: si usa la velocità relativa al suolo
      const omega = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), -23.4393 * Math.PI / 180);
      const ground = along.clone().sub(omega.clone().cross(SM.toThreeAxes(rel.x, rel.y, rel.z, new THREE.Vector3())).multiplyScalar(7.2921159e-5));
      if (ground.length() > 30) axis = ground.normalize();
    } else if (m.phase !== 'countdown' && along.lengthSq() > 0) axis = along.normalize();
    model.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    // getto dei motori (in metri, nel riferimento del modello)
    const t = m.telemetry();
    this.timer.update();
    const firing = t.thrust > 0 && (m.phase === 'ascent' || !!m.burn);
    const d = model.stageDiameter;
    this.plume.update(this.timer.getElapsed(), d, t.altitude, firing, 1);
    this.plume.mesh.position.set(0, model.stageBase, 0);
    if (this.plume.mesh.parent !== model.group) model.group.add(this.plume.mesh);
  }

  minDistance(): number {
    return this.model ? this.model.size * this.metersToScene() * 0.6 : 1e-9;
  }

  /** Posizione in scena di un punto assoluto (eclittica, baricentrico) relativo al corpo `body`. */
  private mapAbs(body: string, rel: Vec3, out: THREE.Vector3): THREE.Vector3 {
    const center = this.sim.get(body);
    const cs = this.natural.scenePosition(body) ?? this.tmp.set(0, 0, 0);
    if (center.kind === 'star') return this.scale.mapHeliocentric(rel, out).add(cs);
    return this.scale.mapSatelliteOffset(rel, center, out).add(cs);
  }

  update(realDt: number, showOrbits: boolean): void {
    const m = this.mission;
    if (!m) return;
    this.dominant = m.phase === 'countdown' || m.phase === 'ascent' ? 'earth' : m.dominant();
    const rel = m.position.sub(this.sim.position(this.dominant));
    this.mapAbs(this.dominant, rel, this.scenePos);
    const attr = this.marker.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, this.scenePos.x, this.scenePos.y, this.scenePos.z);
    attr.needsUpdate = true;
    this.anchor.position.copy(this.scenePos);
    this.labelEl.classList.toggle('focused', this.focused);
    this.updateModel(m);

    // Scia (ricostruita a ogni frame: i punti sono relativi a corpi in movimento)
    const pts = m.trail;
    const n = pts.length + 1;
    let pos = (this.trail.geometry.getAttribute('position') as THREE.BufferAttribute | undefined);
    if (!pos || pos.count < n) {
      this.trail.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(64, n * 2) * 3), 3));
      this.trail.geometry = g;
      pos = g.getAttribute('position') as THREE.BufferAttribute;
    }
    const buf = new Float64Array(n * 3);
    pts.forEach((p, i) => {
      this.mapAbs(p.body, p.rel, this.tmp);
      buf[i * 3] = this.tmp.x;
      buf[i * 3 + 1] = this.tmp.y;
      buf[i * 3 + 2] = this.tmp.z;
    });
    buf.set([this.scenePos.x, this.scenePos.y, this.scenePos.z], pts.length * 3);
    lineRebaser.set(this.trail, buf, n);
    this.trail.geometry.setDrawRange(0, n);
    this.trail.visible = showOrbits;

    // Traiettoria prevista (conica osculante attorno al corpo dominante)
    this.clock += realDt;
    if (this.clock > 0.2) {
      this.clock = 0;
      this.rebuildPredicted(m);
    }
    this.predictedGroup.visible = showOrbits && m.phase !== 'countdown';
    this.predictedGroup.position.copy(this.natural.scenePosition(this.dominant) ?? this.tmp.set(0, 0, 0));
  }

  private rebuildPredicted(m: LaunchMission): void {
    const body = this.sim.get(this.dominant);
    const rel = m.position.sub(this.sim.position(this.dominant));
    const vrel = m.velocity.sub(this.sim.velocity(this.dominant));
    if (rel.lengthSq() === 0 || vrel.lengthSq() === 0) return;
    const mu = this.sim.bodies.filter((x) => x.id === this.dominant || (x.parentId === this.dominant && this.dominant !== 'earth')).reduce((a, x) => a + x.gm, 0);
    const el = stateToElements(rel, vrel, mu);
    const maxR = body.kind === 'star' ? 60 * 1.496e11 : body.soi;
    const pts = sampleOrbit(el, 360, Math.max(maxR, rel.length() * 1.5));
    const cnt = Math.min(361, pts.length);
    const buf = new Float64Array(cnt * 3);
    pts.forEach((p, i) => {
      if (i >= cnt) return;
      if (body.kind === 'star') this.scale.mapHeliocentric(p, this.tmp);
      else this.scale.mapSatelliteOffset(p, body, this.tmp);
      buf[i * 3] = this.tmp.x;
      buf[i * 3 + 1] = this.tmp.y;
      buf[i * 3 + 2] = this.tmp.z;
    });
    lineRebaser.set(this.predicted, buf, cnt);
    this.predicted.geometry.setDrawRange(0, Math.min(361, pts.length));
    this.predicted.computeLineDistances();
    const mat = this.predicted.material as THREE.LineDashedMaterial;
    const size = Math.max(this.scale.visualRadius(body) * 0.05, 1e-4);
    mat.dashSize = size;
    mat.gapSize = size * 0.7;
  }

  // ── Camera e picking ──
  scenePosition(): THREE.Vector3 | undefined {
    return this.mission ? this.scenePos : undefined;
  }

  focusDistance(): number {
    // primo piano sul veicolo (in salita si vede la Terra sotto); con la rotella si torna alla vista d'insieme
    if (this.model && this.mission && (this.mission.phase === 'countdown' || this.mission.phase === 'ascent')) {
      return this.model.size * this.metersToScene() * 2.5;
    }
    const body = this.sim.get(this.dominant);
    if (body.kind === 'star') return this.scale.mode === 'log' ? 30 : 15;
    const R = this.scale.visualRadius(body);
    const cs = this.natural.scenePosition(this.dominant);
    const off = cs ? this.scenePos.distanceTo(cs) : R;
    return Math.max(R * 0.6, off * 0.35);
  }

  focusDirection(): THREE.Vector3 | undefined {
    const cs = this.natural.scenePosition(this.dominant);
    if (!cs || this.dominant === 'sun') return undefined;
    const radial = this.scenePos.clone().sub(cs).normalize();
    if (this.mission && (this.mission.phase === 'countdown' || this.mission.phase === 'ascent')) {
      // di lato, poco sopra il suolo: orizzonte e cielo sullo sfondo
      const side = new THREE.Vector3(0, 1, 0).cross(radial);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      return side.normalize().addScaledVector(radial, 0.3).normalize();
    }
    return radial.add(new THREE.Vector3(0, 0.5, 0)).normalize();
  }

  avoid(): ReturnType<SolarSystemView["obstacle"]> {
    if (this.dominant === 'sun') return undefined;
    return this.natural.obstacle(this.dominant);
  }

  pickSource(): PickSource {
    return {
      priority: true,
      screenCandidates: () => (this.mission ? [{ id: LAUNCH_ID, pos: this.scenePos }] : []),
    };
  }
}
