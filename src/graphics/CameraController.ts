/**
 * CameraController — OrbitControls (rotazione, pan, zoom) + "aggancio" a un corpo in movimento.
 *
 * Aggancio: ad ogni frame il target dei controlli e la camera vengono traslati della stessa
 * quantità di cui si è spostato il corpo, così la vista resta solidale al corpo mentre
 * l'utente può continuare a ruotare/zoomare. Il pan dell'utente viene mantenuto come offset.
 * Il cambio di corpo è animato (target e distanza interpolati, la distanza in scala logaritmica).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface FocusProvider {
  scenePosition(id: string): THREE.Vector3 | undefined;
  focusDistance(id: string): number;
  minDistance(id: string): number;
  /** Direzione preferita (dal target verso la camera) quando si aggancia `id`. */
  focusDirection?(id: string): THREE.Vector3 | undefined;
  /** Sfera che la camera non deve attraversare (es. il pianeta attorno a cui orbita un satellite). */
  avoid?(id: string): { center: THREE.Vector3; radius: number; pole?: THREE.Vector3; flattening?: number } | undefined;
}

interface Transition {
  fromTarget: THREE.Vector3;
  fromDistance: number;
  toDistance: number;
  /** Direzione iniziale e finale della camera rispetto al target. */
  fromDir: THREE.Vector3;
  toDir: THREE.Vector3 | null;
  t: number;
  duration: number;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  focusId: string;
  private readonly provider: FocusProvider;
  private readonly panOffset = new THREE.Vector3();
  private transition: Transition | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, provider: FocusProvider, initialFocus = 'sun') {
    this.camera = camera;
    this.provider = provider;
    this.focusId = initialFocus;
    const c = new OrbitControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.screenSpacePanning = true;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 1.4;
    c.maxDistance = 1e6;
    this.controls = c;
  }

  get isTransitioning(): boolean {
    return this.transition !== null;
  }

  /** Aggancia la camera al corpo `id`. `distance` opzionale, altrimenti quella suggerita. */
  focus(id: string, animate = true, distance?: number): void {
    this.focusId = id;
    this.panOffset.set(0, 0, 0);
    this.controls.minDistance = 0; // evita salti durante la transizione
    const fromDir = this.camera.position.clone().sub(this.controls.target);
    if (fromDir.lengthSq() === 0) fromDir.set(0, 0.5, 1);
    fromDir.normalize();
    const toDir = this.provider.focusDirection?.(id)?.clone().normalize() ?? null;
    this.transition = {
      fromTarget: this.controls.target.clone(),
      fromDir,
      toDir,
      fromDistance: Math.max(this.camera.position.distanceTo(this.controls.target), 1e-9),
      toDistance: distance ?? this.provider.focusDistance(id),
      t: 0,
      duration: animate ? 1.4 : 0,
    };
  }

  update(realDt: number): void {
    const p = this.provider.scenePosition(this.focusId);
    if (!p) return;
    const { camera, controls } = this;
    const tr = this.transition;

    if (tr) {
      tr.t = tr.duration > 0 ? Math.min(1, tr.t + realDt / tr.duration) : 1;
      const s = easeInOutCubic(tr.t);
      const dist = Math.exp(THREE.MathUtils.lerp(Math.log(tr.fromDistance), Math.log(tr.toDistance), s));
      const dir = this.tmp.copy(tr.fromDir);
      if (tr.toDir) dir.lerp(tr.toDir, s);
      if (dir.lengthSq() < 1e-12) dir.set(0, 0.5, 1);
      dir.normalize();
      controls.target.lerpVectors(tr.fromTarget, p, s);
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      if (tr.t >= 1) {
        this.transition = null;
        controls.minDistance = this.provider.minDistance(this.focusId);
      }
    } else {
      // Segue il corpo: sposta target e camera dello stesso delta
      const desired = this.tmp.copy(p).add(this.panOffset);
      const delta = desired.clone().sub(controls.target);
      camera.position.add(delta);
      controls.target.copy(desired);
    }

    controls.update();
    // La camera non deve entrare nel pianeta attorno a cui orbita l'oggetto seguito
    const obstacle = this.provider.avoid?.(this.focusId);
    if (obstacle) {
      const away = camera.position.clone().sub(obstacle.center);
      // raggio della superficie (ellissoide) nella direzione della camera, appena sopra il suolo
      let k = 1;
      if (obstacle.pole && obstacle.flattening) {
        const sl = away.clone().normalize().dot(obstacle.pole);
        const q = 1 - obstacle.flattening;
        k = 1 / Math.sqrt(1 - sl * sl + (sl * sl) / (q * q));
      }
      const min = obstacle.radius * k * 1.000003;
      if (away.length() < min) {
        if (away.lengthSq() === 0) away.set(0, 1, 0);
        camera.position.copy(obstacle.center).addScaledVector(away.normalize(), min);
      }
    }
    // Il pan eventualmente applicato dall'utente diventa un offset rispetto al corpo
    if (!this.transition) this.panOffset.subVectors(controls.target, p);
  }

  /** Da chiamare al resize. */
  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
