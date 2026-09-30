/**
 * Superficie terrestre ad alta risoluzione (solo grafica).
 *
 * Quando la camera scende vicino alla Terra (un lancio, un satellite in orbita bassa) la mappa
 * globale da 4096 px (≈10 km per pixel) non basta: qui la superficie viene ricoperta da "tile" di
 * immagini satellitari reali, scelte con un quadtree in base alla distanza dalla camera, fino a
 * ~0,5 m/pixel (Esri World Imagery) o 10 m/pixel (Sentinel-2 cloudless di EOX), con il rilievo del
 * terreno (AWS Terrain Tiles, formato Terrarium). Le tile passano dal proxy locale con cache su disco.
 *
 * Le tile vivono nel riferimento solidale con la Terra (stesso orientamento della sfera grafica) e
 * sono appoggiate sullo stesso ellissoide grafico usato dallo shader del pianeta e dallo ScaleManager:
 * in scala logaritmica le quote vicino al suolo sono esagerate di ×1,28 come quelle dei veicoli.
 */
import * as THREE from 'three';
import { FLATTENING } from './bodyRotation.ts';
import type { ScaleManager } from './ScaleManager.ts';
import type { SolarSystemView } from './SolarSystemView.ts';
import { loadTexture } from './assets.ts';

export type SurfaceSource = 'esri' | 's2' | 'off';

export const SURFACE_SOURCES: Record<SurfaceSource, { label: string; maxZoom: number; credit: string }> = {
  esri: { label: 'Esri World Imagery (fino a ~0,5 m)', maxZoom: 18, credit: 'Immagini: Esri, Maxar, Earthstar Geographics' },
  s2: { label: 'Sentinel-2 cloudless 2023 (10 m)', maxZoom: 15, credit: 'Sentinel-2 cloudless 2023 © EOX IT Services (Copernicus Sentinel data 2023)' },
  off: { label: 'Solo mappa globale (NASA)', maxZoom: 0, credit: '' },
};

const F = FLATTENING.earth;
const E2 = F * (2 - F);
/** Esagerazione delle quote vicino al suolo nella scala logaritmica: 2,95 / ln 10. */
const LOG_ALT_GAIN = 2.95 / Math.LN10;
const MAX_TILES = 170;
/** Dimensione a video [px] oltre la quale una tile (256 px) viene suddivisa. */
const TARGET_PX = 420;
const TERRAIN_MAX_Z = 13;
const MAX_LOADS = 6;

const TILE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 tileCenter;
attribute vec2 guv;
varying vec2 vUv;
varying vec2 vGuv;
varying vec3 vNormal;
varying vec3 vUp;
void main() {
  vUv = uv;
  vGuv = guv;
  vNormal = normalize(mat3(modelMatrix) * normal);
  // verticale locale: dal centro della Terra (coordinate locali piccole, niente perdita di precisione)
  vUp = normalize(mat3(modelMatrix) * (tileCenter + position));
  // modelViewMatrix è calcolata in doppia precisione sulla CPU: vertici stabili anche a pochi metri
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const TILE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float hasMap;
uniform sampler2D baseMap;
uniform sampler2D nightMap;
uniform vec3 sunDir;
uniform float sunLight;
uniform float ambient;
varying vec2 vUv;
varying vec2 vGuv;
varying vec3 vNormal;
varying vec3 vUp;
void main() {
  #include <logdepthbuf_fragment>
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  // leggermente davanti all'ellissoide "ray-traced" del pianeta, che sta esattamente sotto
  gl_FragDepth -= 2e-6;
  #endif
  vec3 albedo = hasMap > 0.5 ? texture2D(map, vUv).rgb : texture2D(baseMap, vGuv).rgb;
  vec3 N = normalize(vNormal);
  vec3 up = normalize(vUp);
  float NgL = dot(up, sunDir);
  float NdL = max(dot(N, sunDir), 0.0);
  float diffuse = NdL * smoothstep(-0.03, 0.06, NgL);
  vec3 col = albedo * (diffuse * sunLight + ambient);
  float night = smoothstep(0.08, -0.18, NgL);
  col += texture2D(nightMap, vGuv).rgb * night * 1.6;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Tile {
  key: string;
  z: number;
  x: number;
  y: number;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  tex: THREE.Texture | null;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Quota del terreno applicata (livello della tile di rilievo usata, −1 = piatta). */
  terrainZ: number;
  lastUsed: number;
  priority: number;
  source: SurfaceSource;
}

function tileLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return Math.atan(Math.sinh(n));
}

function mercY(lat: number): number {
  return (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2;
}

export class EarthTiles {
  readonly group = new THREE.Group();
  source: SurfaceSource = 'esri';
  /** Crediti da mostrare quando le tile sono visibili (vuoto = nessuna tile a video). */
  credit = '';
  /** Quota della camera sulla Terra grafica [m] (diagnostica). */
  debugAlt = NaN;
  private readonly tiles = new Map<string, Tile>();
  private readonly heights = new Map<string, Promise<Float32Array | null>>();
  private readonly heightReady = new Map<string, Float32Array | null>();
  private loading = 0;
  private frame = 0;
  private readonly sim: { get(id: string): { radius: number } };
  private readonly scale: ScaleManager;
  private readonly natural: SolarSystemView;
  private readonly shared: Record<string, THREE.IUniform>;
  private s = 1;
  private gain = 1;
  private A = 6378137;
  private readonly camLocal = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(sim: { get(id: string): { radius: number } }, scale: ScaleManager, natural: SolarSystemView) {
    this.sim = sim;
    this.scale = scale;
    this.natural = natural;
    this.group.visible = false;
    this.shared = {
      baseMap: { value: null },
      nightMap: { value: null },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      sunLight: { value: 1 },
      ambient: { value: 0.012 },
      earthCenter: { value: new THREE.Vector3() },
    };
    void loadTexture('earth_day.jpg').then((t) => (this.shared.baseMap.value = t));
    void loadTexture('earth_night.jpg').then((t) => (this.shared.nightMap.value = t));
  }

  // ───────────────────────── Geometria ─────────────────────────

  /** Geodetiche → coordinate locali della Terra grafica (X = Greenwich, Y = polo, −Z = 90° E). */
  private geoToLocal(lat: number, lon: number, h: number, out: THREE.Vector3): THREE.Vector3 {
    const sl = Math.sin(lat);
    const cl = Math.cos(lat);
    const N = this.A / Math.sqrt(1 - E2 * sl * sl);
    const hh = h * this.gain;
    const X = (N + hh) * cl * Math.cos(lon);
    const Y = (N + hh) * cl * Math.sin(lon);
    const Z = (N * (1 - E2) + hh) * sl;
    return out.set(X * this.s, Z * this.s, -Y * this.s);
  }

  /** Quota del terreno [m] in un punto, se la tile di rilievo è già in memoria. */
  private heightAt(lat: number, lon: number, zt: number): number | null {
    const n = 2 ** zt;
    const fx = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const fy = mercY(lat) * n;
    const xt = Math.min(n - 1, Math.max(0, Math.floor(fx)));
    const yt = Math.min(n - 1, Math.max(0, Math.floor(fy)));
    const hm = this.heightReady.get(`${zt}/${xt}/${yt}`);
    if (!hm) return null;
    const px = Math.min(255, Math.max(0, (fx - xt) * 256 - 0.5));
    const py = Math.min(255, Math.max(0, (fy - yt) * 256 - 0.5));
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(255, x0 + 1);
    const y1 = Math.min(255, y0 + 1);
    const tx = px - x0;
    const ty = py - y0;
    const a = hm[y0 * 256 + x0] * (1 - tx) + hm[y0 * 256 + x1] * tx;
    const b = hm[y1 * 256 + x0] * (1 - tx) + hm[y1 * 256 + x1] * tx;
    return Math.max(0, a * (1 - ty) + b * ty); // mare e bacini sotto zero: livello del mare
  }

  private loadHeights(zt: number, x: number, y: number): Promise<Float32Array | null> {
    const key = `${zt}/${x}/${y}`;
    let p = this.heights.get(key);
    if (!p) {
      p = new Promise<Float32Array | null>((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, 256, 256);
          const d = ctx.getImageData(0, 0, 256, 256).data;
          const h = new Float32Array(256 * 256);
          for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
          resolve(h);
        };
        img.onerror = () => resolve(null);
        img.src = `/api/terrain?z=${zt}&x=${x}&y=${y}`;
      }).then((h) => {
        this.heightReady.set(key, h);
        return h;
      });
      this.heights.set(key, p);
    }
    return p as Promise<Float32Array | null>;
  }

  private buildGeometry(t: Tile, zt: number): void {
    const { z, x, y } = t;
    const seg = z <= 8 ? 32 : z <= 12 ? 24 : 16;
    const lon0 = (x / 2 ** z) * 2 * Math.PI - Math.PI;
    const lon1 = ((x + 1) / 2 ** z) * 2 * Math.PI - Math.PI;
    const lat0 = tileLat(y, z); // nord
    const lat1 = tileLat(y + 1, z); // sud
    const center = this.geoToLocal((lat0 + lat1) / 2, (lon0 + lon1) / 2, 0, new THREE.Vector3());
    const n1 = seg + 1;
    // griglia + "gonna" sul bordo (nasconde le fessure fra tile di livello diverso)
    const count = n1 * n1 + 4 * n1;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const guv = new Float32Array(count * 2);
    const my0 = mercY(lat0);
    const my1 = mercY(lat1);
    const p = new THREE.Vector3();
    const put = (k: number, lat: number, lon: number, h: number, u: number, v: number) => {
      this.geoToLocal(lat, lon, h, p).sub(center);
      pos[k * 3] = p.x;
      pos[k * 3 + 1] = p.y;
      pos[k * 3 + 2] = p.z;
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
      guv[k * 2] = (lon + Math.PI) / (2 * Math.PI);
      guv[k * 2 + 1] = (lat + Math.PI / 2) / Math.PI;
    };
    const latAt = (j: number) => {
      // passo uniforme in Mercatore (come la texture)
      const my = my0 + ((my1 - my0) * j) / seg;
      return Math.atan(Math.sinh(Math.PI * (1 - 2 * my)));
    };
    const heightsAt = (lat: number, lon: number) => (zt >= 0 ? this.heightAt(lat, lon, zt) ?? 0 : 0);
    for (let j = 0; j <= seg; j++) {
      const lat = latAt(j);
      for (let i = 0; i <= seg; i++) {
        const lon = lon0 + ((lon1 - lon0) * i) / seg;
        put(j * n1 + i, lat, lon, heightsAt(lat, lon), i / seg, 1 - j / seg);
      }
    }
    const tileW = Math.max(1, (this.A * (lon1 - lon0) * Math.cos((lat0 + lat1) / 2)));
    const skirt = -tileW * 0.015;
    let k = n1 * n1;
    const edge: number[] = [];
    const sides: [number, number][][] = [
      Array.from({ length: n1 }, (_, i) => [0, i]),
      Array.from({ length: n1 }, (_, i) => [seg, i]),
      Array.from({ length: n1 }, (_, j) => [j, 0]),
      Array.from({ length: n1 }, (_, j) => [j, seg]),
    ];
    for (const side of sides) {
      for (const [j, i] of side) {
        const lat = latAt(j);
        const lon = lon0 + ((lon1 - lon0) * i) / seg;
        put(k, lat, lon, heightsAt(lat, lon) + skirt / this.gain, i / seg, 1 - j / seg);
        edge.push(k);
        k++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n1 + i;
        const b = a + 1;
        const c = a + n1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // gonne: quad fra il bordo della griglia e la copia abbassata
    let e = 0;
    for (const side of sides) {
      for (let m = 0; m < seg; m++) {
        const a = side[m][0] * n1 + side[m][1];
        const b = side[m + 1][0] * n1 + side[m + 1][1];
        const a2 = edge[e + m];
        const b2 = edge[e + m + 1];
        idx.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2);
      }
      e += n1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('guv', new THREE.BufferAttribute(guv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    t.mesh.geometry.dispose();
    t.mesh.geometry = g;
    t.mesh.position.copy(center);
    (t.mat.uniforms.tileCenter.value as THREE.Vector3).copy(center);
    t.terrainZ = zt;
  }

  private createTile(z: number, x: number, y: number): Tile {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, map: { value: null }, hasMap: { value: 0 }, tileCenter: { value: new THREE.Vector3() } },
      vertexShader: TILE_VERTEX,
      fragmentShader: TILE_FRAGMENT,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.renderOrder = -1;
    const t: Tile = {
      key: `${z}/${x}/${y}`, z, x, y, mesh, mat, tex: null, state: 'idle', terrainZ: -2, lastUsed: this.frame, priority: 0, source: this.source,
    };
    this.buildGeometry(t, -1);
    this.group.add(mesh);
    this.tiles.set(t.key, t);
    return t;
  }

  private disposeTile(t: Tile): void {
    t.mesh.removeFromParent();
    t.mesh.geometry.dispose();
    t.mat.dispose();
    t.tex?.dispose();
    this.tiles.delete(t.key);
  }

  /** Cambia la sorgente delle immagini (le tile già caricate vengono ricaricate). */
  setSource(src: SurfaceSource): void {
    if (src === this.source) return;
    this.source = src;
    for (const t of [...this.tiles.values()]) this.disposeTile(t);
  }

  // ───────────────────────── Aggiornamento per frame ─────────────────────────

  update(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.frame++;
    const vis = this.natural.visuals.get('earth');
    if (!vis || this.source === 'off') {
      this.group.visible = false;
      this.credit = '';
      return;
    }
    const earth = this.sim.get('earth');
    // metri reali → unità della Terra grafica (stesso ellissoide dello shader del pianeta)
    this.A = earth.radius / (1 - F / 3);
    const Req = vis.baseRadius * this.scale.equatorialFactor(vis.body);
    this.s = Req / this.A;
    this.gain = this.scale.mode === 'log' ? LOG_ALT_GAIN : 1;
    this.group.position.copy(vis.scenePos);
    this.group.quaternion.copy(vis.mesh.quaternion);
    this.group.updateMatrixWorld(true);
    this.camLocal.copy(camera.position);
    this.group.worldToLocal(this.camLocal);
    // camera in "metri" della Terra grafica (ECEF: x Greenwich, y 90° E, z polo)
    const cx = this.camLocal.x / this.s;
    const cy = -this.camLocal.z / this.s;
    const cz = this.camLocal.y / this.s;
    const rho = Math.hypot(cx, cy);
    const r = Math.hypot(rho, cz);
    const rSurf = this.A * Math.sqrt((1 - E2) / (1 - E2 * Math.cos(Math.atan2(cz, rho)) ** 2));
    const h = r - rSurf;
    this.debugAlt = h;
    if (!(h < 2.5e6) || h < -1e5) {
      this.group.visible = false;
      this.credit = '';
      this.evict(true);
      return;
    }
    this.group.visible = true;
    this.credit = SURFACE_SOURCES[this.source].credit + ' · Rilievo: AWS Terrain Tiles (Mapzen)';
    this.shared.earthCenter.value.copy(vis.scenePos);
    if (vis.light) this.shared.sunDir.value.copy(vis.light.sunPos.value).normalize();

    // quadtree: tile foglia vicine alla camera, più fitte dove la camera è vicina al suolo
    const maxZ = SURFACE_SOURCES[this.source].maxZoom;
    const cover = Math.min(Math.sqrt(2 * this.A * Math.max(h, 1) + h * h) * 1.2 + 20e3, 6e6);
    const pxPerRad = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    type Node = { z: number; x: number; y: number; d: number; score: number };
    const leaves: Node[] = [];
    const cam = new THREE.Vector3(cx, cy, cz);
    const c = new THREE.Vector3();
    const corner = new THREE.Vector3();
    const ecef = (la: number, lo: number, out: THREE.Vector3) => {
      const sl = Math.sin(la);
      const N = this.A / Math.sqrt(1 - E2 * sl * sl);
      return out.set(N * Math.cos(la) * Math.cos(lo), N * Math.cos(la) * Math.sin(lo), N * (1 - E2) * sl);
    };
    const makeNode = (z: number, x: number, y: number): Node | null => {
      const lo0 = (x / 2 ** z) * 2 * Math.PI - Math.PI;
      const lo1 = ((x + 1) / 2 ** z) * 2 * Math.PI - Math.PI;
      const la0 = tileLat(y, z);
      const la1 = tileLat(y + 1, z);
      ecef((la0 + la1) / 2, (lo0 + lo1) / 2, c);
      const half = Math.max(ecef(la0, lo0, corner).distanceTo(c), ecef(la1, lo1, corner).distanceTo(c), ecef(la0, lo1, corner).distanceTo(c));
      const d = Math.max(0, cam.distanceTo(c) - half);
      if (d > cover) return null;
      // dietro l'orizzonte: la tile è interamente "sotto" il piano tangente visto dalla camera
      if (z >= 5 && c.clone().normalize().dot(cam.clone().sub(c)) < -half * 1.2 && d > 50e3) return null;
      // bisogno di dettaglio: dimensione apparente (in pixel) della tile, con la sua obliquità
      const tilt = Math.max(0.25, Math.abs(c.clone().normalize().dot(cam.clone().sub(c).normalize())));
      return { z, x, y, d, score: ((half * 2) / Math.max(d, h * 0.5, 1)) * pxPerRad * Math.sqrt(tilt) };
    };
    // raffinamento a budget: si divide sempre la tile che ha più bisogno di dettaglio
    const open: Node[] = [];
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      const nd = makeNode(3, x, y);
      if (nd) open.push(nd);
    }
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].score > open[bi].score) bi = i;
      const nd = open.splice(bi, 1)[0];
      if (nd.z < maxZ && nd.score > TARGET_PX && leaves.length + open.length + 4 <= MAX_TILES) {
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const ch = makeNode(nd.z + 1, nd.x * 2 + dx, nd.y * 2 + dy);
          if (ch) open.push(ch);
        }
      } else leaves.push(nd);
    }

    const used = new Set<string>();
    for (const L of leaves) {
      const key = `${L.z}/${L.x}/${L.y}`;
      used.add(key);
      const t = this.tiles.get(key) ?? this.createTile(L.z, L.x, L.y);
      t.lastUsed = this.frame;
      t.priority = L.d;
      t.mesh.visible = true;
      // rilievo: tile Terrarium del livello più vicino disponibile (fino a 13)
      const zt = L.z >= 6 ? Math.min(L.z, TERRAIN_MAX_Z) : -1;
      if (zt >= 0 && t.terrainZ !== zt) {
        const k = L.z - zt;
        const hx = L.x >> k;
        const hy = L.y >> k;
        const hkey = `${zt}/${hx}/${hy}`;
        if (this.heightReady.has(hkey)) {
          if (this.heightReady.get(hkey)) this.buildGeometry(t, zt);
          else t.terrainZ = zt; // rilievo non disponibile: resta piatta
        } else void this.loadHeights(zt, hx, hy);
      }
    }
    for (const t of this.tiles.values()) if (!used.has(t.key)) t.mesh.visible = false;
    this.pump();
    this.evict(false);
  }

  /** Scarica le immagini delle tile visibili, prima le più vicine. */
  private pump(): void {
    if (this.loading >= MAX_LOADS) return;
    const wanted = [...this.tiles.values()].filter((t) => t.mesh.visible && t.state === 'idle').sort((a, b) => a.priority - b.priority);
    for (const t of wanted) {
      if (this.loading >= MAX_LOADS) break;
      t.state = 'loading';
      this.loading++;
      const src = this.source;
      new THREE.TextureLoader().load(
        `/api/tile?src=${src}&z=${t.z}&x=${t.x}&y=${t.y}`,
        (tex) => {
          this.loading--;
          if (!this.tiles.has(t.key) || t.source !== this.source) {
            tex.dispose();
            return;
          }
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.needsUpdate = true;
          t.tex = tex;
          t.mat.uniforms.map.value = tex;
          t.mat.uniforms.hasMap.value = 1;
          t.state = 'ready';
        },
        undefined,
        () => {
          this.loading--;
          t.state = 'failed';
        },
      );
    }
  }

  private evict(all: boolean): void {
    if (!all && this.tiles.size <= MAX_TILES * 1.5) return;
    const old = [...this.tiles.values()].filter((t) => !t.mesh.visible).sort((a, b) => a.lastUsed - b.lastUsed);
    const excess = all ? old.length : this.tiles.size - MAX_TILES;
    for (let i = 0; i < excess && i < old.length; i++) if (old[i].state !== 'loading') this.disposeTile(old[i]);
  }

  /**
   * Raggio in scena del suolo (ellissoide + rilievo, se noto) sotto il punto `p` della scena.
   * Serve ad appoggiare il razzo sul terreno in rampa.
   */
  groundRadius(p: THREE.Vector3): number | null {
    const vis = this.natural.visuals.get('earth');
    if (!vis || !this.group.visible) return null;
    const l = this.group.worldToLocal(this.tmp.copy(p));
    const cx = l.x / this.s;
    const cy = -l.z / this.s;
    const cz = l.y / this.s;
    const rho = Math.hypot(cx, cy);
    const lat = Math.atan2(cz, rho * (1 - E2));
    const lon = Math.atan2(cy, cx);
    let hgt = 0;
    for (let zt = TERRAIN_MAX_Z; zt >= 6; zt--) {
      const v = this.heightAt(lat, lon, zt);
      if (v !== null) {
        hgt = v;
        break;
      }
    }
    return this.geoToLocal(lat, lon, hgt, this.tmp).length();
  }
}
