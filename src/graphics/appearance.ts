/**
 * Aspetto dei corpi naturali: texture reali (NASA/USGS/JPL, pubblico dominio) e parametri ottici.
 * Le immagini sono in public/textures (vedi public/textures/CREDITS.md).
 */

export interface AtmosphereDef {
  /** Colore della luce diffusa (lineare). */
  color: [number, number, number];
  /** Colore al tramonto/terminatore. */
  sunset?: [number, number, number];
  /** Spessore apparente, in raggi del corpo. */
  height: number;
  /** Intensità. */
  strength: number;
}

export interface Appearance {
  map?: string;
  normalMap?: string;
  nightMap?: string;
  specularMap?: string;
  cloudMap?: string;
  /** Moltiplica la texture (mappe in scala di grigi → colore reale). */
  tint?: [number, number, number];
  /** Saturazione dei colori (1 = come la mappa; le mappe "a colori esaltati" vanno attenuate). */
  saturation?: number;
  /** 0 = Lambert (nubi, gas), 1 = Lommel-Seeliger (regolite: la Luna piena non ha bordo scuro). */
  regolith?: number;
  /** Oscuramento al bordo dei pianeti gassosi. */
  limbDarkening?: number;
  atmosphere?: AtmosphereDef;
  rings?: boolean;
}

export const APPEARANCE: Record<string, Appearance> = {
  mercury: { map: 'mercury.jpg', tint: [0.86, 0.8, 0.74], regolith: 1 },
  venus: {
    map: 'venus.jpg', limbDarkening: 0.25,
    atmosphere: { color: [1.0, 0.86, 0.6], sunset: [1.0, 0.6, 0.3], height: 0.035, strength: 0.9 },
  },
  earth: {
    map: 'earth_day.jpg', nightMap: 'earth_night.jpg', specularMap: 'earth_specular.jpg', cloudMap: 'earth_clouds.jpg',
    atmosphere: { color: [0.3, 0.55, 1.0], sunset: [1.0, 0.45, 0.2], height: 0.028, strength: 1.2 },
  },
  mars: {
    map: 'mars.jpg', regolith: 0.5,
    atmosphere: { color: [0.95, 0.65, 0.45], sunset: [0.45, 0.6, 0.9], height: 0.015, strength: 0.35 },
  },
  jupiter: { map: 'jupiter.jpg', limbDarkening: 0.35, atmosphere: { color: [0.85, 0.8, 0.72], height: 0.012, strength: 0.25 } },
  saturn: { map: 'saturn.jpg', limbDarkening: 0.35, rings: true, atmosphere: { color: [0.9, 0.82, 0.62], height: 0.012, strength: 0.25 } },
  uranus: { map: 'uranus.jpg', limbDarkening: 0.3, atmosphere: { color: [0.6, 0.88, 0.95], height: 0.02, strength: 0.45 } },
  neptune: { map: 'neptune.jpg', limbDarkening: 0.3, atmosphere: { color: [0.35, 0.55, 1.0], height: 0.02, strength: 0.45 } },
  pluto: { map: 'pluto.jpg', regolith: 0.8, saturation: 0.85, atmosphere: { color: [0.55, 0.7, 1.0], height: 0.012, strength: 0.15 } },
  moon: { map: 'moon.jpg', normalMap: 'moon_normal.jpg', regolith: 1 },
  phobos: { map: 'phobos.jpg', tint: [0.62, 0.56, 0.5], regolith: 1 },
  deimos: { map: 'deimos.jpg', tint: [0.74, 0.67, 0.6], regolith: 1 },
  io: { map: 'io.jpg', regolith: 0.7, saturation: 0.6 },
  europa: { map: 'europa.jpg', tint: [0.96, 0.9, 0.8], regolith: 0.6 },
  ganymede: { map: 'ganymede.jpg', tint: [0.86, 0.8, 0.74], regolith: 0.8 },
  callisto: { map: 'callisto.jpg', tint: [0.7, 0.62, 0.54], regolith: 0.9 },
  titan: {
    map: 'titan.jpg', limbDarkening: 0.2,
    atmosphere: { color: [0.95, 0.62, 0.3], sunset: [0.6, 0.35, 0.2], height: 0.08, strength: 1.1 },
  },
  titania: { map: 'titania.jpg', tint: [0.82, 0.78, 0.74], regolith: 0.9 },
  oberon: { map: 'oberon.jpg', tint: [0.76, 0.7, 0.66], regolith: 0.9 },
  triton: { map: 'triton.jpg', regolith: 0.8 },
  charon: { map: 'charon.jpg', regolith: 0.9 },
};

/** Anelli di Saturno: struttura radiale reale (km dal centro; profondità ottica indicativa). */
export const SATURN_EQ_RADIUS_KM = 60268;
export const RING_INNER_KM = 66900;
export const RING_OUTER_KM = 140400;

/** [raggio km, opacità, luminosità] — dati Voyager/Cassini semplificati. */
export const RING_PROFILE: [number, number, number][] = [
  [66900, 0.0, 0.3], [67500, 0.02, 0.35], [74400, 0.03, 0.35], // anello D
  [74658, 0.08, 0.45], [80000, 0.12, 0.5], [85000, 0.16, 0.52], [90000, 0.22, 0.58], [91900, 0.3, 0.62], // C
  [92000, 0.78, 0.9], [96000, 0.86, 0.95], [100000, 0.93, 1.0], [106000, 0.97, 1.0], [110000, 0.95, 0.98], [115000, 0.9, 0.95], [117400, 0.85, 0.92], // B
  [117580, 0.1, 0.45], [119000, 0.06, 0.4], [120500, 0.12, 0.45], [122000, 0.18, 0.5], // divisione di Cassini
  [122170, 0.62, 0.86], [126000, 0.68, 0.88], [130000, 0.66, 0.86], [133350, 0.6, 0.83],
  [133423, 0.03, 0.4], [133745, 0.03, 0.4], // lacuna di Encke
  [133800, 0.55, 0.8], [136400, 0.5, 0.78], [136487, 0.05, 0.4], [136522, 0.05, 0.4], [136560, 0.4, 0.72], [136775, 0.35, 0.7], // A + Keeler
  [136800, 0.0, 0.3], [140000, 0.0, 0.3], [140120, 0.35, 0.7], [140250, 0.35, 0.7], [140400, 0.0, 0.3], // anello F
];
