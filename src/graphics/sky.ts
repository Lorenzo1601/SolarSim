/**
 * Cielo reale: Via Lattea (NASA SVS "Deep Star Maps 2020", senza le stelle luminose) e le 9.096
 * stelle del Yale Bright Star Catalogue (BSC5) con magnitudine e colore (indice B−V) veri.
 * Coordinate equatoriali J2000 → eclittica → assi di scena. L'oggetto va posto sulla camera a ogni frame.
 */
import * as THREE from 'three';
import { OBLIQUITY_J2000 } from '../physics/constants.ts';
import { loadBinary, loadTexture } from './assets.ts';
import { ScaleManager } from './ScaleManager.ts';

const SKY_RADIUS = 4e5;

const MILKY_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const MILKY_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float intensity;
uniform float cosE;
uniform float sinE;
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  // scena (x, y=nord eclittica, z=−y_ecl) → eclittica → equatoriale J2000
  vec3 ecl = vec3(d.x, -d.z, d.y);
  vec3 eq = vec3(ecl.x, cosE * ecl.y - sinE * ecl.z, sinE * ecl.y + cosE * ecl.z);
  float ra = atan(eq.y, eq.x);
  float dec = asin(clamp(eq.z, -1.0, 1.0));
  // mappa NASA: centrata su 0h, ascensione retta crescente verso sinistra
  vec2 uv = vec2(fract(0.5 - ra / (2.0 * PI)), 0.5 + dec / PI);
  vec3 c = texture2D(map, uv).rgb;
  gl_FragColor = vec4(c * intensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float mag;
attribute vec3 starColor;
uniform float pixelRatio;
uniform float brightness;
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  float flux = pow(10.0, -0.4 * (mag - 1.0));
  gl_PointSize = clamp(1.7 + 2.3 * sqrt(flux), 1.5, 10.0) * pixelRatio;
  vColor = starColor;
  vAlpha = clamp(0.2 + flux, 0.12, 1.6) * brightness;
  #include <logdepthbuf_vertex>
}
`;

const STAR_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = exp(-d * 5.0);
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Indice di colore B−V → colore RGB lineare (temperatura di corpo nero). */
export function bvToRgb(bv: number): [number, number, number] {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  const T = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  // approssimazione di Tanner Helland (sRGB), poi linearizzata
  const t = T / 100;
  let r: number, g: number, bl: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    bl = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    bl = 255;
  }
  const lin = (v: number) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2);
  // si attenua la saturazione: a occhio nudo le stelle sono quasi bianche
  const c = [lin(r), lin(g), lin(bl)].map((v) => 0.45 + 0.55 * v);
  const m = Math.max(...c);
  return [c[0] / m, c[1] / m, c[2] / m];
}

export class Sky {
  readonly root = new THREE.Group();
  private readonly milkyMat: THREE.ShaderMaterial;
  private readonly starMat: THREE.ShaderMaterial;

  constructor(pixelRatio: number) {
    this.root.renderOrder = -10;
    this.milkyMat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        intensity: { value: 0 },
        cosE: { value: Math.cos(OBLIQUITY_J2000) },
        sinE: { value: Math.sin(OBLIQUITY_J2000) },
      },
      vertexShader: MILKY_VERTEX,
      fragmentShader: MILKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const milky = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 32), this.milkyMat);
    milky.renderOrder = -11;
    milky.frustumCulled = false;
    milky.raycast = () => {};
    this.root.add(milky);
    void loadTexture('milkyway.jpg').then((t) => {
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      this.milkyMat.uniforms.map.value = t;
      this.milkyMat.uniforms.intensity.value = 0.16;
    });

    this.starMat = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: pixelRatio }, brightness: { value: 1 } },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    void loadBinary('stars_bsc5.bin').then((buf) => this.buildStars(new Float32Array(buf)));
  }

  private buildStars(data: Float32Array): void {
    const n = data.length / 4;
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const c = Math.cos(OBLIQUITY_J2000);
    const s = Math.sin(OBLIQUITY_J2000);
    const v = new THREE.Vector3();
    const R = SKY_RADIUS * 0.9;
    for (let i = 0; i < n; i++) {
      const ra = THREE.MathUtils.degToRad(data[i * 4]);
      const dec = THREE.MathUtils.degToRad(data[i * 4 + 1]);
      const x = Math.cos(dec) * Math.cos(ra);
      const y = Math.cos(dec) * Math.sin(ra);
      const z = Math.sin(dec);
      ScaleManager.toThreeAxes(x, c * y + s * z, -s * y + c * z, v).multiplyScalar(R);
      pos.set([v.x, v.y, v.z], i * 3);
      mag[i] = data[i * 4 + 2];
      col.set(bvToRgb(data[i * 4 + 3]), i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('starColor', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, this.starMat);
    pts.frustumCulled = false;
    pts.renderOrder = -10;
    pts.raycast = () => {};
    this.root.add(pts);
  }

  /** Il cielo segue la camera (è "all'infinito"). */
  update(camera: THREE.Camera): void {
    this.root.position.copy(camera.position);
  }
}
