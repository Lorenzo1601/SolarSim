/** Texture procedurali: anelli di Saturno (struttura radiale reale). */
import * as THREE from 'three';


/**
 * Anelli di Saturno con la struttura radiale reale (anelli D, C, B, divisione di Cassini, A con le
 * lacune di Encke e Keeler, anello F). u = (r − r_interno) / (r_esterno − r_interno); alfa = opacità.
 */
export function createSaturnRingTexture(profile: [number, number, number][], inner: number, outer: number, w = 4096): THREE.Texture {
  const data = new Uint8Array(w * 4);
  let s = 99;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // micro-struttura: centinaia di "ringlet" (onde di densità) sovrapposte
  const fine = new Float32Array(w);
  for (let k = 0; k < 6; k++) {
    const f = 40 + rnd() * 900;
    const ph = rnd() * 6.28;
    for (let x = 0; x < w; x++) fine[x] += Math.sin((x / w) * f + ph) / 6;
  }
  let j = 0;
  for (let x = 0; x < w; x++) {
    const r = inner + ((x + 0.5) / w) * (outer - inner);
    while (j < profile.length - 2 && profile[j + 1][0] < r) j++;
    const [r0, a0, b0] = profile[j];
    const [r1, a1, b1] = profile[j + 1];
    const t = r1 > r0 ? Math.min(1, Math.max(0, (r - r0) / (r1 - r0))) : 0;
    let a = a0 + (a1 - a0) * t;
    let b = b0 + (b1 - b0) * t;
    const n = 1 + 0.12 * fine[x] + 0.06 * (rnd() - 0.5);
    a = Math.min(1, Math.max(0, a * n));
    b = Math.min(1, b * (1 + 0.05 * fine[x]));
    // colore: anello C grigio-bruno, B color crema, A più grigio
    const cr = r < 92000 ? [0.62, 0.56, 0.5] : r < 117580 ? [0.92, 0.84, 0.7] : [0.84, 0.8, 0.74];
    data[x * 4] = Math.round(255 * Math.min(1, cr[0] * b));
    data[x * 4 + 1] = Math.round(255 * Math.min(1, cr[1] * b));
    data[x * 4 + 2] = Math.round(255 * Math.min(1, cr[2] * b));
    data[x * 4 + 3] = Math.round(255 * a);
  }
  const tex = new THREE.DataTexture(data, w, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
