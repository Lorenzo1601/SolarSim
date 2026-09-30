/**
 * Atmosfera terrestre:
 *  - 0–86 km: U.S. Standard Atmosphere 1976 (temperatura, pressione, densità, velocità del suono);
 *  - 86–1000 km: modello esponenziale a tratti (Vallado) per la densità (resistenza in orbita bassa).
 */
const R_AIR = 287.05287; // J/(kg·K)
const GMR = 0.0341631947; // g0·M/R [K/m]
const GAMMA = 1.4;

// quota geopotenziale base [m], T base [K], gradiente [K/m], P base [Pa]
const LAYERS: [number, number, number, number][] = [
  [0, 288.15, -0.0065, 101325],
  [11000, 216.65, 0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.956420],
  [84852, 186.87, 0, 0.3734],
];

// quota [km], densità [kg/m³], altezza di scala [km]
const EXPO: [number, number, number][] = [
  [80, 1.905e-5, 5.799], [90, 3.396e-6, 5.382], [100, 5.297e-7, 5.877], [110, 9.661e-8, 7.263],
  [120, 2.438e-8, 9.473], [130, 8.484e-9, 12.636], [140, 3.845e-9, 16.149], [150, 2.07e-9, 22.523],
  [180, 5.464e-10, 29.74], [200, 2.789e-10, 37.105], [250, 7.248e-11, 45.546], [300, 2.418e-11, 53.628],
  [350, 9.518e-12, 53.298], [400, 3.725e-12, 58.515], [450, 1.585e-12, 60.828], [500, 6.967e-13, 63.822],
  [600, 1.454e-13, 71.835], [700, 3.614e-14, 88.667], [800, 1.17e-14, 124.64], [900, 5.245e-15, 181.05],
  [1000, 3.019e-15, 268],
];

export interface AtmosphereState {
  /** Densità [kg/m³] */
  rho: number;
  /** Pressione [Pa] */
  p: number;
  /** Temperatura [K] */
  T: number;
  /** Velocità del suono [m/s] */
  a: number;
}

export const P0 = 101325;

export function atmosphere(hGeometric: number): AtmosphereState {
  const h = Math.max(hGeometric, -500);
  if (h < 86000) {
    const hg = (6356766 * h) / (6356766 + h); // quota geopotenziale
    let i = LAYERS.length - 1;
    while (i > 0 && hg < LAYERS[i][0]) i--;
    const [hb, Tb, L, Pb] = LAYERS[i];
    const T = Tb + L * (hg - hb);
    const p = L === 0 ? Pb * Math.exp((-GMR * (hg - hb)) / Tb) : Pb * Math.pow(Tb / T, GMR / L);
    return { rho: p / (R_AIR * T), p, T, a: Math.sqrt(GAMMA * R_AIR * T) };
  }
  const km = h / 1000;
  if (km > 1000) return { rho: 0, p: 0, T: 1000, a: 0 };
  let i = EXPO.length - 1;
  while (i > 0 && km < EXPO[i][0]) i--;
  const [h0, rho0, H] = EXPO[i];
  const rho = rho0 * Math.exp(-(km - h0) / H);
  return { rho, p: rho * R_AIR * 186.87, T: 186.87, a: Math.sqrt(GAMMA * R_AIR * 186.87) };
}

/** Coefficiente di resistenza in funzione del numero di Mach (tipico di un lanciatore). */
export function dragCoefficient(mach: number, cd0: number): number {
  let k: number;
  if (mach < 0.8) k = 1;
  else if (mach < 1.2) k = 1 + (0.6 * (mach - 0.8)) / 0.4; // salita transonica
  else if (mach < 3) k = 1.6 - (0.6 * (mach - 1.2)) / 1.8;
  else k = Math.max(0.8, 1 - 0.05 * (mach - 3));
  return cd0 * k;
}
