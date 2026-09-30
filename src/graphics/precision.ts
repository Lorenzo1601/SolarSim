/**
 * Precisione delle linee vicino alla camera.
 *
 * Le posizioni dei vertici di una BufferGeometry sono in float32 (≈7 cifre): una traiettoria che
 * passa a 400 unità dal Sole ha un errore di ~2·10⁻⁵ unità per vertice. Se la camera è a 10⁻⁶ unità
 * da una sonda (primo piano del modello 3D), quell'errore è 20 volte la distanza di vista e la linea
 * "trema" e salta a ogni movimento.
 *
 * Soluzione (origine locale): per ogni linea si tengono i punti in float64 e, quando serve, si
 * riscrivono i float32 relativi a un'origine vicina al punto inquadrato; lo spostamento viene messo
 * in `line.position` (float64, combinato dalle matrici calcolate in JavaScript). Così i vertici vicini
 * alla camera hanno coordinate piccole e quindi precise.
 */
import * as THREE from 'three';

interface Entry {
  local: Float64Array;
  offset: THREE.Vector3;
}

export class LineRebaser {
  private readonly lines = new Map<THREE.Line | THREE.Points, Entry>();
  private readonly tmp = new THREE.Vector3();
  private readonly parentPos = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private camDist = Infinity;

  /**
   * Imposta i punti (coordinate locali del genitore della linea, float64) e scrive il buffer.
   * `count` = numero di punti validi (gli altri restano invariati).
   */
  set(line: THREE.Line | THREE.Points, points: ArrayLike<number>, count = points.length / 3): void {
    let e = this.lines.get(line);
    if (!e || e.local.length < count * 3) {
      e = { local: new Float64Array(Math.max(count * 3, 3)), offset: new THREE.Vector3() };
      this.lines.set(line, e);
    }
    for (let i = 0; i < count * 3; i++) e.local[i] = points[i];
    e.offset.copy(this.desiredOffset(line));
    this.write(line, e, count);
  }

  forget(line: THREE.Line | THREE.Points): void {
    this.lines.delete(line);
  }

  /** Da chiamare a ogni frame prima del render: origin = punto inquadrato, camDist = distanza della camera. */
  update(origin: THREE.Vector3, camDist: number): void {
    this.origin.copy(origin);
    this.camDist = camDist;
    for (const [line, e] of this.lines) {
      if (!line.parent) {
        this.lines.delete(line);
        continue;
      }
      if (!line.visible) continue;
      const want = this.desiredOffset(line);
      const drift = want.distanceTo(e.offset);
      // riscrittura solo quando l'origine si è spostata di molto rispetto alla distanza di vista
      if (drift > camDist * 8 || (want.lengthSq() === 0 && e.offset.lengthSq() > 0)) {
        e.offset.copy(want);
        const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        this.write(line, e, attr ? Math.min(attr.count, e.local.length / 3) : e.local.length / 3);
      }
    }
  }

  private desiredOffset(line: THREE.Object3D): THREE.Vector3 {
    this.parentPos.set(0, 0, 0);
    for (let p = line.parent; p; p = p.parent) this.parentPos.add(p.position);
    const o = this.tmp.copy(this.origin).sub(this.parentPos);
    // l'origine locale serve solo quando l'errore float32 diventa visibile a questa distanza
    if (!(o.length() > this.camDist * 3e3)) return o.set(0, 0, 0);
    return o;
  }

  private write(line: THREE.Line | THREE.Points, e: Entry, count: number): void {
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const a = attr.array as Float32Array;
    const n = Math.min(count, attr.count);
    const { x, y, z } = e.offset;
    for (let i = 0; i < n; i++) {
      a[i * 3] = e.local[i * 3] - x;
      a[i * 3 + 1] = e.local[i * 3 + 1] - y;
      a[i * 3 + 2] = e.local[i * 3 + 2] - z;
    }
    attr.needsUpdate = true;
    line.position.copy(e.offset);
    line.geometry.boundingSphere = null;
  }
}

/** Istanza condivisa da tutte le viste. */
export const lineRebaser = new LineRebaser();
