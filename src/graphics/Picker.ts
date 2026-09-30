/**
 * Picker — selezione di un oggetto cliccando nella scena, da più sorgenti (corpi naturali,
 * oggetti artificiali, nuvole di satelliti).
 *  1) sorgenti "prioritarie" (marcatori di satelliti/sonde e punti dei cataloghi): il più vicino al
 *     cursore entro 10 px, purché davanti al corpo colpito dal raggio (così cliccando la ISS davanti
 *     alla Terra si seleziona la ISS, ma non un satellite nascosto dietro il pianeta);
 *  2) il corpo colpito dal Raycaster;
 *  3) il candidato più vicino in spazio schermo entro 16 px (corpi di pochi pixel).
 * Un trascinamento (rotazione/pan) non viene interpretato come clic.
 */
import * as THREE from 'three';

export interface PickCandidate {
  id: string;
  pos: THREE.Vector3;
}

export interface PickSource {
  /** Candidati controllati prima del raycasting. */
  priority?: boolean;
  raycastTargets?(): THREE.Object3D[];
  idOf?(obj: THREE.Object3D): string | undefined;
  screenCandidates(): Iterable<PickCandidate>;
}

const CLICK_TOLERANCE_PX = 5;
const PRIORITY_RADIUS_PX = 10;
const SCREEN_PICK_RADIUS_PX = 16;

export class Picker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly sources: PickSource[];
  private readonly onPick: (id: string) => void;
  private down: { x: number; y: number } | null = null;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, sources: PickSource[], onPick: (id: string) => void) {
    this.camera = camera;
    this.dom = dom;
    this.sources = sources;
    this.onPick = onPick;
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.down = { x: e.clientX, y: e.clientY };
    });
    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved > CLICK_TOLERANCE_PX) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id) this.onPick(id);
    });
  }

  /**
   * Candidato più vicino al cursore entro `radius` px. Con `maxDepth` si scartano quelli più lontani
   * dalla camera del primo oggetto solido colpito (es. satelliti nascosti dietro la Terra).
   */
  private nearestOnScreen(sources: PickSource[], clientX: number, clientY: number, radius: number, maxDepth = Infinity): string | null {
    const rect = this.dom.getBoundingClientRect();
    const p = new THREE.Vector3();
    let best: string | null = null;
    let bestD = radius;
    for (const s of sources) {
      for (const c of s.screenCandidates()) {
        if (maxDepth < Infinity && c.pos.distanceTo(this.camera.position) > maxDepth) continue;
        p.copy(c.pos).project(this.camera);
        if (p.z < -1 || p.z > 1) continue; // dietro la camera / oltre il far plane
        const sx = ((p.x + 1) / 2) * rect.width + rect.left;
        const sy = ((1 - p.y) / 2) * rect.height + rect.top;
        const d = Math.hypot(sx - clientX, sy - clientY);
        if (d < bestD) {
          bestD = d;
          best = c.id;
        }
      }
    }
    return best;
  }

  pick(clientX: number, clientY: number): string | null {
    // Raycasting sulle sfere dei corpi: primo oggetto solido sotto il cursore
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    let hitId: string | null = null;
    let hitDist = Infinity;
    for (const s of this.sources) {
      if (!s.raycastTargets || !s.idOf) continue;
      for (const h of this.raycaster.intersectObjects(s.raycastTargets(), false)) {
        const id = s.idOf(h.object);
        if (id && h.distance < hitDist) {
          hitId = id;
          hitDist = h.distance;
        }
      }
    }

    // 1) Marcatori prioritari (satelliti, sonde) davanti al corpo colpito
    const prio = this.sources.filter((s) => s.priority);
    const first = this.nearestOnScreen(prio, clientX, clientY, PRIORITY_RADIUS_PX, hitDist);
    if (first) return first;

    // 2) Corpo colpito dal raggio
    if (hitId) return hitId;

    // 3) Ricerca in spazio schermo su tutte le sorgenti
    return this.nearestOnScreen(this.sources, clientX, clientY, SCREEN_PICK_RADIUS_PX);
  }
}
