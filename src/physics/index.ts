/** Punto di ingresso pubblico del motore fisico. */
export * from './constants.ts';
export * from './vec3.ts';
export * from './frames.ts';
export * from './kepler.ts';
export * from './nbody.ts';
export * from './initialState.ts';
export * from './simulation.ts';
export { SOLAR_SYSTEM, findBody } from '../data/bodies.ts';
export type { BodyDef, BodyKind, PlanetElements, MoonElements } from '../data/bodies.ts';
