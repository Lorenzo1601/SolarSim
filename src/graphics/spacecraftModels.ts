/**
 * Modelli 3D degli oggetti artificiali.
 *  - modelli ufficiali NASA (NASA 3D Resources, pubblico dominio) per i veicoli principali,
 *    ottimizzati (Draco + WebP) in public/models e riportati alle dimensioni reali
 *  - modelli procedurali per chi non ne ha uno (sonde, satelliti, razzi) e per gli asteroidi
 * Ogni modello è un THREE.Group in cui 1 unità = 1 metro; chi lo usa lo scala in unità di scena.
 */
import * as THREE from 'three';
import { loadModel } from './assets.ts';

interface ModelSpec {
  file: string;
  /** Dimensione massima reale [m]. */
  size: number;
  /** Mesh da scartare (parti estranee nel file originale). */
  exclude?: RegExp;
}

const NASA: Record<string, ModelSpec> = {
  iss: { file: 'iss.glb', size: 109, exclude: /^(bendedtru|pCylinder)/ },
  hubble: { file: 'hubble.glb', size: 13.2 },
  chandra: { file: 'chandra.glb', size: 19.5 },
  tess: { file: 'tess.glb', size: 3.9 },
  fermi: { file: 'fermi.glb', size: 7 },
  swift: { file: 'swift.glb', size: 5.6 },
  jwst: { file: 'jwst.glb', size: 21.2 },
  soho: { file: 'soho.glb', size: 9.5 },
  landsat8: { file: 'landsat8.glb', size: 9 },
  landsat9: { file: 'landsat8.glb', size: 9 },
  terra: { file: 'aqua.glb', size: 16.7 },
  aqua: { file: 'aqua.glb', size: 16.7 },
  noaa20: { file: 'npp.glb', size: 8 },
  goes16: { file: 'goes.glb', size: 12 },
  goes19: { file: 'goes.glb', size: 12 },
  voyager1: { file: 'voyager.glb', size: 15 },
  voyager2: { file: 'voyager.glb', size: 15 },
  parker: { file: 'parker.glb', size: 3 },
  juno: { file: 'juno.glb', size: 20.1 },
  mro: { file: 'mro.glb', size: 13.6 },
  odyssey: { file: 'odyssey.glb', size: 5.7 },
  lro: { file: 'lro.glb', size: 5 },
  pioneer10: { file: 'pioneer.glb', size: 7 },
  pioneer11: { file: 'pioneer.glb', size: 7 },
  stereoa: { file: 'stereo.glb', size: 8 },
  osirisapex: { file: 'osirisrex.glb', size: 6.2 },
  saturnv: { file: 'saturnv.glb', size: 110.6 },
};

/** Dimensioni indicative dei veicoli senza modello NASA [m]. */
const GENERIC_SIZE: Record<string, number> = {
  css: 55, xmm: 16, nustar: 11, ixpe: 5, xrism: 8, euclid: 4.7, newhorizons: 2.7, solo: 18, europaclipper: 30.5,
  juice: 27, bepicolombo: 30, lucy: 16, psyche: 25, hera: 12, hayabusa2: 6, gaia: 10, marsexpress: 12,
  tgo: 17.5, hope: 8, danuri: 6, chandrayaan2: 8, vanguard1: 0.9,
};

export const ROCKET_HEIGHT: Record<string, number> = {
  falcon9: 70, falconheavy: 70, atlas551: 62, ariane64: 62, vegac: 35, electron: 18, sls1: 98, saturnv: 110.6, starship: 123,
};

// ───────────────────────── Materiali procedurali ─────────────────────────

const mat = {
  foil: new THREE.MeshStandardMaterial({ color: 0xd4a53c, metalness: 0.85, roughness: 0.35 }),
  silver: new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.7, roughness: 0.4 }),
  white: new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.05, roughness: 0.6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x333338, metalness: 0.3, roughness: 0.6 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x1b2a55, metalness: 0.5, roughness: 0.25, emissive: 0x020410 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x6f6862, metalness: 0, roughness: 1 }),
  black: new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.2, roughness: 0.7 }),
};

function box(w: number, h: number, d: number, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
}

/** Sonda/satellite generico: corpo, due ali di pannelli solari, antenna parabolica. */
export function genericProbe(size = 6, seed = 1): THREE.Group {
  const g = new THREE.Group();
  const s = size / 6;
  const body = box(1.6 * s, 1.4 * s, 1.6 * s, seed % 2 ? mat.foil : mat.silver);
  g.add(body);
  for (const side of [-1, 1]) {
    const arm = box(0.6 * s, 0.06 * s, 0.06 * s, mat.silver);
    arm.position.set(side * 1.1 * s, 0, 0);
    g.add(arm);
    const panel = box(1.9 * s, 0.03 * s, 1.0 * s, mat.panel);
    panel.position.set(side * 2.35 * s, 0, 0);
    g.add(panel);
  }
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9 * s, 24, 8, 0, Math.PI * 2, 0, Math.PI / 5), mat.white);
  dish.material.side = THREE.DoubleSide;
  dish.rotation.x = Math.PI;
  dish.position.set(0, 1.55 * s, 0);
  g.add(dish);
  const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * s, 0.04 * s, 0.7 * s), mat.silver);
  feed.position.set(0, 1.1 * s, 0);
  g.add(feed);
  return g;
}

/** Vanguard 1: sfera di 16 cm con sei antenne. */
function vanguard(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 24, 16), mat.silver));
  for (let i = 0; i < 6; i++) {
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.3), mat.silver);
    const dir = new THREE.Vector3(Math.cos(i), Math.sin(i * 1.7), Math.cos(i * 2.3)).normalize();
    a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    a.position.copy(dir.multiplyScalar(0.2));
    g.add(a);
  }
  return g;
}

/** Asteroide: sfera deformata con rumore (forma irregolare), diametro in metri. */
export function asteroid(diameter: number, seed = 1): THREE.Group {
  const geo = new THREE.IcosahedronGeometry(0.5, 5);
  const pos = geo.attributes.position;
  let s = seed * 9973 + 17;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // forma: lobi ampi (asteroide "a mucchio di detriti") + crateri
  const lobes = Array.from({ length: 9 }, () => ({
    d: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
    a: (rnd() - 0.45) * 0.5,
    w: 1.5 + rnd() * 3,
  }));
  const craters = Array.from({ length: 45 }, () => ({
    d: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
    r: 0.05 + Math.pow(rnd(), 2) * 0.35,
    depth: 0.02 + rnd() * 0.05,
  }));
  const elong = new THREE.Vector3(1 + rnd() * 0.7, 0.75 + rnd() * 0.25, 0.7 + rnd() * 0.2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 0.5;
    for (const b of lobes) r += b.a * Math.exp(-b.w * (1 - v.dot(b.d))) * 0.5;
    for (const c of craters) {
      const ang = Math.acos(Math.min(1, v.dot(c.d)));
      const x = ang / c.r;
      if (x < 1.3) r += x < 1 ? -c.depth * (1 - x * x) : c.depth * 0.6 * Math.cos(((x - 1) / 0.3) * Math.PI / 2) ** 2;
    }
    // rugosità fine
    r += (Math.sin(v.x * 37 + seed) * Math.sin(v.y * 41) * Math.sin(v.z * 29)) * 0.012;
    v.multiplyScalar(r).multiply(elong);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat.rock);
  m.scale.setScalar(diameter / 1.3);
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** Razzo procedurale: stadi, ogiva, booster laterali (visione d'insieme, non in scala di dettaglio). */
export function proceduralRocket(height: number, diameter: number, boosters: number, stack: 'full' | 'upper'): THREE.Group {
  const g = new THREE.Group();
  const r = diameter / 2;
  if (stack === 'full') {
    const h1 = height * 0.6;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h1, 32), mat.white);
    core.position.y = h1 / 2;
    g.add(core);
    const inter = new THREE.Mesh(new THREE.CylinderGeometry(r, r, height * 0.05, 32), mat.black);
    inter.position.y = h1 + height * 0.025;
    g.add(inter);
    const h2 = height * 0.2;
    const second = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h2, 32), mat.white);
    second.position.y = h1 + height * 0.05 + h2 / 2;
    g.add(second);
    const fair = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.25, r * 1.1, height * 0.15, 32), mat.white);
    fair.position.y = height * 0.925;
    g.add(fair);
    for (let i = 0; i < boosters; i++) {
      const a = (i / boosters) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, h1 * 0.8, 20), mat.white);
      b.position.set(Math.cos(a) * r * 1.6, h1 * 0.4, Math.sin(a) * r * 1.6);
      g.add(b);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(r * 0.55, r * 1.4, 20), mat.white);
      nose.position.set(b.position.x, h1 * 0.8 + r * 0.7, b.position.z);
      g.add(nose);
    }
    const engines = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r * 1.0, height * 0.02, 24), mat.dark);
    engines.position.y = -height * 0.01;
    g.add(engines);
  } else {
    const h = height * 0.22;
    const st = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), mat.white);
    st.position.y = h / 2;
    g.add(st);
    const bell = new THREE.Mesh(new THREE.ConeGeometry(r * 0.6, r * 1.2, 24, 1, true), mat.dark);
    bell.position.y = -r * 0.5;
    bell.rotation.x = Math.PI;
    g.add(bell);
    const probe = genericProbe(diameter * 1.4, 2);
    probe.position.y = h + diameter * 0.5;
    g.add(probe);
  }
  return g;
}

// ───────────────────────── Istanze ─────────────────────────

/** Normalizza un modello: centrato nell'origine, dimensione massima = size metri. */
function normalize(src: THREE.Object3D, size: number, exclude?: RegExp): THREE.Group {
  const obj = src.clone(true);
  if (exclude) {
    const drop: THREE.Object3D[] = [];
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && exclude.test(o.name)) drop.push(o);
    });
    for (const o of drop) o.removeFromParent();
  }
  obj.updateMatrixWorld(true);
  const box3 = new THREE.Box3().setFromObject(obj);
  const dims = box3.getSize(new THREE.Vector3());
  const center = box3.getCenter(new THREE.Vector3());
  const k = size / Math.max(dims.x, dims.y, dims.z, 1e-9);
  obj.position.sub(center);
  const inner = new THREE.Group();
  inner.add(obj);
  inner.scale.setScalar(k);
  const g = new THREE.Group();
  g.add(inner);
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.frustumCulled = false;
      m.raycast = () => {};
    }
  });
  return g;
}

export class SpacecraftModel {
  readonly group = new THREE.Group();
  /** Dimensione massima reale [m]. */
  readonly size: number;
  ready = false;

  constructor(id: string, opts: { category?: string; diameterKm?: number } = {}) {
    this.group.visible = false;
    const spec = NASA[id];
    if (spec) {
      this.size = spec.size;
      // in attesa del file: sagoma generica
      const placeholder = genericProbe(spec.size);
      this.group.add(placeholder);
      loadModel(spec.file).then((gltf) => {
        placeholder.removeFromParent();
        this.group.add(normalize(gltf.scene, spec.size, spec.exclude));
        this.ready = true;
      }).catch(() => (this.ready = true));
      return;
    }
    if (opts.category === 'asteroid' || opts.category === 'tno') {
      const d = (opts.diameterKm ?? 1) * 1000;
      this.size = d;
      let h = 0;
      for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      this.group.add(asteroid(d, (h % 1000) + 1));
    } else if (id === 'vanguard1') {
      this.size = 0.9;
      this.group.add(vanguard());
    } else {
      this.size = GENERIC_SIZE[id] ?? 6;
      let h = 0;
      for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      this.group.add(genericProbe(this.size, h));
    }
    this.ready = true;
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

/** Il veicolo del simulatore di lancio: pila completa, stadio superiore + carico, o solo il carico. */
export class RocketModel {
  readonly group = new THREE.Group();
  height: number;
  private stage: 'full' | 'upper' | 'payload' | '' = '';
  private readonly rocketId: string;
  private readonly diameter: number;
  private readonly boosters: number;

  constructor(rocketId: string, diameter: number, boosters: number) {
    this.rocketId = rocketId;
    this.diameter = diameter;
    this.boosters = boosters;
    this.height = ROCKET_HEIGHT[rocketId] ?? diameter * 18;
  }

  /** Aggiorna la configurazione (chiamare quando cambia la fase). */
  setStage(stage: 'full' | 'upper' | 'payload'): void {
    if (stage === this.stage) return;
    this.stage = stage;
    for (const c of [...this.group.children]) if (!c.userData.keep) c.removeFromParent();
    if (stage === 'full' && this.rocketId === 'saturnv') {
      const spec = NASA.saturnv;
      const ph = proceduralRocket(this.height, this.diameter, 0, 'full');
      this.group.add(ph);
      loadModel(spec.file).then((gltf) => {
        if (this.stage !== 'full') return;
        ph.removeFromParent();
        const m = normalize(gltf.scene, spec.size);
        m.position.y = spec.size / 2; // base del razzo nell'origine
        this.group.add(m);
      }).catch(() => {});
    } else if (stage === 'payload') {
      this.group.add(genericProbe(Math.max(3, this.diameter * 1.5), 3));
    } else {
      this.group.add(proceduralRocket(this.height, this.diameter, this.boosters, stage));
    }
    this.group.traverse((o) => ((o as THREE.Mesh).raycast = () => {}));
  }

  /** Diametro degli ugelli attivi [m] e quota della base del modello rispetto all'origine. */
  get stageDiameter(): number {
    return this.stage === 'full' ? this.diameter * (this.boosters > 0 ? 1.6 : 1) : this.stage === 'upper' ? this.diameter * 0.7 : 0.6;
  }

  get stageBase(): number {
    if (this.stage === 'full') return this.rocketId === 'saturnv' ? 0 : -this.height * 0.02;
    return this.stage === 'upper' ? -this.diameter * 1.1 : -this.diameter * 0.8;
  }

  /** Dimensione massima corrente [m]. */
  get size(): number {
    return this.stage === 'full' ? this.height : this.stage === 'upper' ? this.height * 0.3 : Math.max(3, this.diameter * 1.5);
  }
}

// ───────────────────────── Getto dei motori ─────────────────────────

const PLUME_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const PLUME_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float time;
uniform float intensity;
uniform float vacuum;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  // v = 1 all'ugello, 0 in fondo al getto
  float along = 1.0 - vUv.y;
  float flicker = 0.85 + 0.15 * sin(time * 40.0 + along * 30.0) * sin(time * 23.0);
  float core = exp(-along * mix(6.0, 2.5, vacuum));
  // diamanti d'urto (solo in atmosfera)
  float diamonds = (1.0 - vacuum) * 0.35 * pow(0.5 + 0.5 * cos(along * 38.0), 6.0) * exp(-along * 3.0);
  vec3 hot = vec3(1.0, 0.95, 0.85);
  vec3 warm = mix(vec3(1.0, 0.55, 0.18), vec3(0.55, 0.65, 1.0), vacuum);
  vec3 col = mix(warm, hot, core) * (core + diamonds) * flicker * intensity;
  gl_FragColor = vec4(col * 2.2, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Getto dei motori: cono additivo che si allunga e si allarga salendo (pressione ambiente minore). */
export class ExhaustPlume {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, intensity: { value: 1 }, vacuum: { value: 0 } },
      vertexShader: PLUME_VERTEX,
      fragmentShader: PLUME_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.CylinderGeometry(1, 0.35, 1, 24, 1, true);
    geo.translate(0, -0.5, 0); // ugello nell'origine, getto verso −Y
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.raycast = () => {};
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.userData.keep = true;
  }

  /** diameter = diametro del razzo [m]; altitude [m]; on = motori accesi. */
  update(time: number, diameter: number, altitude: number, on: boolean, throttle = 1): void {
    this.mesh.visible = on;
    if (!on) return;
    const vac = Math.min(1, Math.max(0, altitude / 60000));
    const len = diameter * (4 + 10 * vac) * (0.6 + 0.4 * throttle);
    const width = diameter * (0.45 + 1.6 * vac * vac);
    this.mesh.scale.set(width, len, width);
    this.mat.uniforms.time.value = time;
    this.mat.uniforms.vacuum.value = vac;
    this.mat.uniforms.intensity.value = 0.7 + 0.3 * throttle;
  }
}
