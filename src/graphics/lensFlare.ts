/**
 * Riflessi dell'obiettivo (lens flare) del Sole, disegnati in sovrimpressione dopo il
 * post-processing. Il Sole è nell'origine della scena; il riflesso sparisce se un corpo lo copre.
 */
import * as THREE from 'three';

function radialTexture(stops: [number, string][], size = 128): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hexTexture(size = 128): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const r = size * 0.44;
    if (i === 0) ctx.moveTo(r * Math.cos(a), r * Math.sin(a));
    else ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.44);
  g.addColorStop(0, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0.15)');
  ctx.fillStyle = g;
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Ghost {
  mesh: THREE.Mesh;
  /** Posizione lungo la linea Sole → centro dello schermo (0 = Sole, 1 = centro, 2 = opposto). */
  at: number;
  size: number;
  opacity: number;
}

export interface Occluder {
  center: THREE.Vector3;
  radius: number;
}

export class LensFlare {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly ghosts: Ghost[] = [];
  private aspect = 1;
  private readonly ndc = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  enabled = true;

  constructor() {
    const soft = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.25, 'rgba(255,230,190,0.35)'], [1, 'rgba(255,200,150,0)']]);
    const ring = radialTexture([[0, 'rgba(255,255,255,0)'], [0.7, 'rgba(255,255,255,0)'], [0.85, 'rgba(160,220,255,0.5)'], [0.92, 'rgba(255,190,160,0.4)'], [1, 'rgba(255,255,255,0)']]);
    const hex = hexTexture();
    const add = (tex: THREE.Texture, at: number, size: number, color: string, opacity: number) => {
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(color), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, opacity });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.scene.add(mesh);
      this.ghosts.push({ mesh, at, size, opacity });
    };
    add(soft, 0, 0.55, '#fff4e0', 0.55);
    add(hex, 0.45, 0.06, '#9fd4ff', 0.18);
    add(hex, 0.7, 0.1, '#ffd29f', 0.12);
    add(soft, 0.95, 0.04, '#b6ff9f', 0.25);
    add(ring, 1.25, 0.32, '#ffffff', 0.14);
    add(hex, 1.5, 0.14, '#c49fff', 0.1);
    add(soft, 1.75, 0.08, '#ff9f9f', 0.18);
    add(hex, 2.1, 0.22, '#9fc4ff', 0.08);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  /**
   * Aggiorna posizione e visibilità. `sunRadius` = raggio grafico del Sole; `occluders` = corpi
   * che possono coprirlo (sfere in scena).
   */
  update(camera: THREE.PerspectiveCamera, sunRadius: number, occluders: Iterable<Occluder>): void {
    let vis = this.enabled ? 1 : 0;
    this.ndc.set(0, 0, 0).project(camera);
    const behind = this.ndc.z > 1 || this.ndc.z < -1;
    if (behind || Math.abs(this.ndc.x) > 1.3 || Math.abs(this.ndc.y) > 1.3) vis = 0;
    const camDist = camera.position.length();
    if (camDist < sunRadius * 1.5) vis = 0;
    if (vis > 0) {
      // occultazione: raggio camera → Sole contro le sfere dei corpi
      const dir = this.tmp.copy(camera.position).multiplyScalar(-1 / camDist);
      for (const o of occluders) {
        const oc = new THREE.Vector3().subVectors(o.center, camera.position);
        const t = oc.dot(dir);
        if (t <= 0 || t >= camDist) continue;
        const d2 = oc.lengthSq() - t * t;
        const sunAng = sunRadius / camDist;
        const sep = Math.sqrt(Math.max(d2, 0)) / t;
        const occAng = o.radius / t;
        if (sep < occAng - sunAng * 0.5) {
          vis = 0;
          break;
        }
        if (sep < occAng + sunAng) vis *= Math.min(1, (sep - (occAng - sunAng * 0.5)) / (sunAng * 1.5));
      }
    }
    // più tenue quando il Sole è grande a video (lo fa già il bagliore)
    const angSize = sunRadius / Math.max(camDist, 1e-9);
    vis *= THREE.MathUtils.clamp(1.2 - angSize * 12, 0, 1);
    const sx = this.ndc.x;
    const sy = this.ndc.y;
    for (const g of this.ghosts) {
      const px = sx * (1 - g.at);
      const py = sy * (1 - g.at);
      g.mesh.position.set(px, py, 0);
      g.mesh.scale.set(g.size / this.aspect, g.size, 1);
      (g.mesh.material as THREE.MeshBasicMaterial).opacity = g.opacity * vis * (g.at === 0 ? 1 : 1 - Math.min(1, Math.hypot(sx, sy) * 0.25));
      g.mesh.visible = vis > 0.01;
    }
  }
}
