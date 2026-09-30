/**
 * ScaleManager — unico punto di conversione fra coordinate FISICHE (motore N-body, metri,
 * eclittica J2000 con Z verso il polo nord dell'eclittica) e coordinate GRAFICHE (Three.js, Y in alto).
 *
 * Non modifica mai la fisica: prende vettori del motore e restituisce THREE.Vector3.
 *
 * Due modalità:
 *  'log'  – Scala grafica logaritmica. Le distanze dal Sole vengono compresse radialmente:
 *              s = K · log10(1 + d / d0)
 *           (la direzione è conservata, cambia solo il modulo), così Mercurio e Plutone
 *           stanno sullo stesso schermo. Le lune usano una seconda mappa locale, relativa al
 *           raggio grafico del pianeta, per non finire "dentro" la sfera del pianeta.
 *           Le dimensioni seguono una legge di potenza R_vis = k · R_km^p (p≈0.3): il Sole resta il
 *           più grande, Giove più grande della Terra, ma tutti sono visibili.
 *  'real' – Scala reale lineare: 1 unità scena = `realUnit` metri (default 1 milione di km),
 *           raggi e distanze veri.
 *
 * In entrambe le modalità viene imposto un raggio minimo in PIXEL (`minPixelRadius`): se un corpo
 * sarebbe più piccolo di così a video, la sua mesh viene ingrandita solo graficamente.
 */
import * as THREE from 'three';
import { AU } from '../physics/constants.ts';
import type { SimBodyKind } from '../physics/simulation.ts';
import type { Vec3 } from '../physics/vec3.ts';

export type ScaleMode = 'log' | 'real';

export interface ScaleSettings {
  /** LOG: unità di scena per decade di distanza. */
  logK: number;
  /** LOG: distanza di riferimento d0 [m]. */
  logD0: number;
  /** LOG: R_vis = sizeScale · f · (R_km)^sizeExponent */
  sizeScale: number;
  sizeExponent: number;
  /** LOG: fattore dimensionale per il Sole e per le lune. */
  starSizeFactor: number;
  moonSizeFactor: number;
  /**
   * LOG: distanza grafica di un satellite = R_vis_pianeta · (base + k · log10(d / R_pianeta)).
   * Con base = 1 la mappa è continua sulla superficie: un satellite a bassa quota (ISS) appare
   * appena sopra la sfera, la Luna a ~6 raggi grafici, JWST (L2) a ~8.
   */
  moonOffsetBase: number;
  moonOffsetLog: number;
  /** REAL: metri per unità di scena. */
  realUnit: number;
  /** Raggio minimo a video [px]. */
  minPixelRadius: number;
}

export const DEFAULT_SCALE_SETTINGS: ScaleSettings = {
  logK: 120,
  logD0: 0.03 * AU,
  sizeScale: 0.13,
  sizeExponent: 0.3,
  starSizeFactor: 2.2,
  moonSizeFactor: 0.5,
  moonOffsetBase: 1.0,
  moonOffsetLog: 2.95,
  realUnit: 1e9,
  minPixelRadius: 3,
};

/** Quanto serve di un corpo per scalarlo. */
export interface ScalableBody {
  kind: SimBodyKind;
  /** Raggio fisico [m]. */
  radius: number;
  id?: string;
}

/** Schiacciamento di un corpo: f e polo nord (versore, frame eclittico del motore). */
interface Oblateness {
  f: number;
  pole: Vec3;
}

export class ScaleManager {
  private _mode: ScaleMode;
  readonly settings: ScaleSettings;
  /** Incrementato a ogni cambio di scala: chi tiene cache (es. linee d'orbita) sa quando ricalcolare. */
  version = 0;
  private readonly oblate = new Map<string, Oblateness>();

  /**
   * Registra lo schiacciamento di un corpo: la quota degli oggetti vicini viene misurata dalla
   * superficie reale dell'ellissoide, così un razzo in rampa poggia sul suolo della sfera grafica.
   */
  setOblateness(id: string, f: number, pole: Vec3): void {
    this.oblate.set(id, { f, pole });
  }

  /** Raggio grafico equatoriale (in scala reale l'ellissoide ha il raggio equatoriale vero). */
  equatorialFactor(body: ScalableBody): number {
    const o = body.id ? this.oblate.get(body.id) : undefined;
    return o && this._mode === 'real' ? 1 / (1 - o.f / 3) : 1;
  }

  constructor(mode: ScaleMode = 'log', settings: Partial<ScaleSettings> = {}) {
    this._mode = mode;
    this.settings = { ...DEFAULT_SCALE_SETTINGS, ...settings };
  }

  get mode(): ScaleMode {
    return this._mode;
  }

  set mode(m: ScaleMode) {
    if (m !== this._mode) {
      this._mode = m;
      this.version++;
    }
  }

  /** Conversione degli assi: motore (x, y, z; Z = nord eclittica) → Three.js (x, z, −y; Y in alto). */
  static toThreeAxes(x: number, y: number, z: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return out.set(x, z, -y);
  }

  /** Conversione inversa: Three.js → assi del motore. */
  static fromThreeAxes(v: THREE.Vector3): { x: number; y: number; z: number } {
    return { x: v.x, y: -v.z, z: v.y };
  }

  /** Distanza fisica dal Sole [m] → distanza in scena. */
  radial(d: number): number {
    const s = this.settings;
    return this._mode === 'real' ? d / s.realUnit : s.logK * Math.log10(1 + d / s.logD0);
  }

  /** Inversa di `radial`: distanza in scena → distanza fisica [m]. */
  inverseRadial(sceneDist: number): number {
    const s = this.settings;
    return this._mode === 'real' ? sceneDist * s.realUnit : s.logD0 * (Math.pow(10, sceneDist / s.logK) - 1);
  }

  /** Vettore fisico relativo al Sole → posizione in scena (Sole nell'origine). */
  mapHeliocentric(rel: Vec3, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const d = rel.length();
    if (d === 0) return out.set(0, 0, 0);
    const k = this.radial(d) / d;
    return ScaleManager.toThreeAxes(rel.x * k, rel.y * k, rel.z * k, out);
  }

  /** Vettore fisico satellite − primario → spostamento in scena rispetto al primario. */
  mapSatelliteOffset(rel: Vec3, primary: ScalableBody, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const d = rel.length();
    if (d === 0) return out.set(0, 0, 0);
    const s = this.settings;
    let sceneDist: number;
    if (this._mode === 'real') {
      sceneDist = d / s.realUnit;
    } else {
      const ob = primary.id ? this.oblate.get(primary.id) : undefined;
      let surfReal = primary.radius;
      let surfVis = 1;
      if (ob) {
        const sinLat = (rel.x * ob.pole.x + rel.y * ob.pole.y + rel.z * ob.pole.z) / d;
        const q = 1 - ob.f;
        // raggio dell'ellissoide nella direzione data (stessa forma usata dallo shader)
        const k = 1 / Math.sqrt(1 - sinLat * sinLat + (sinLat * sinLat) / (q * q));
        surfReal = (primary.radius / (1 - ob.f / 3)) * k;
        surfVis = k;
      }
      const ratio = Math.max(1, d / Math.max(surfReal, 1));
      sceneDist = this.visualRadius(primary) * surfVis * (s.moonOffsetBase + s.moonOffsetLog * Math.log10(ratio));
    }
    const k = sceneDist / d;
    return ScaleManager.toThreeAxes(rel.x * k, rel.y * k, rel.z * k, out);
  }

  /** Raggio grafico "di base" di un corpo in unità di scena (prima del minimo in pixel). */
  visualRadius(body: ScalableBody): number {
    const s = this.settings;
    if (this._mode === 'real') return body.radius / s.realUnit;
    if (body.radius <= 0) return 0;
    const f = body.kind === 'star' ? s.starSizeFactor : body.kind === 'moon' ? s.moonSizeFactor : 1;
    return s.sizeScale * f * Math.pow(body.radius / 1000, s.sizeExponent);
  }

  /** Raggio in unità di scena che corrisponde a `minPixelRadius` pixel alla distanza data. */
  minRadiusAt(distance: number, camera: THREE.PerspectiveCamera, viewportHeight: number): number {
    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    return distance * pxAngle * this.settings.minPixelRadius;
  }

  describe(): string {
    return this._mode === 'real'
      ? `Reale · 1 unità = ${(this.settings.realUnit / 1e9).toLocaleString('it-IT')} milioni di km`
      : 'Logaritmica · distanze compresse, dimensioni esagerate';
  }
}
