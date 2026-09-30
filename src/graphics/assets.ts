/** Caricamento delle texture e dei modelli 3D (cartella public/). */
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

const BASE: string = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

const texLoader = new THREE.TextureLoader();
const cache = new Map<string, Promise<THREE.Texture>>();
let maxAnisotropy = 8;

export function setMaxAnisotropy(n: number): void {
  maxAnisotropy = n;
}

/**
 * Carica una texture da public/textures. `color` = true per le immagini a colori (sRGB),
 * false per i dati (normali, maschere).
 */
export function loadTexture(name: string, color = true): Promise<THREE.Texture> {
  const key = `${name}|${color}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      texLoader.load(
        `${BASE}textures/${name}`,
        (t) => {
          t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = maxAnisotropy;
          t.wrapS = THREE.RepeatWrapping;
          t.needsUpdate = true;
          resolve(t);
        },
        undefined,
        (e) => reject(e),
      );
    });
    cache.set(key, p);
  }
  return p;
}

export async function loadBinary(name: string): Promise<ArrayBuffer> {
  const r = await fetch(`${BASE}textures/${name}`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.arrayBuffer();
}

let gltfLoader: GLTFLoader | null = null;
const modelCache = new Map<string, Promise<GLTF>>();

export function loadModel(name: string): Promise<GLTF> {
  if (!gltfLoader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${BASE}draco/`);
    gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(draco);
  }
  let p = modelCache.get(name);
  if (!p) {
    p = gltfLoader.loadAsync(`${BASE}models/${name}`);
    modelCache.set(name, p);
  }
  return p;
}
