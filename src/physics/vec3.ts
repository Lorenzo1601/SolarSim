/**
 * Vettore 3D in doppia precisione.
 * Le operazioni restituiscono nuovi vettori, tranne i metodi *InPlace.
 * (Il ciclo interno N-body lavora direttamente su Float64Array per prestazioni;
 *  Vec3 serve per l'API, l'analisi orbitale e la telemetria.)
 */
export class Vec3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static fromArray(a: ArrayLike<number>, offset = 0): Vec3 {
    return new Vec3(a[offset], a[offset + 1], a[offset + 2]);
  }

  toArray(out: Float64Array | number[], offset = 0): void {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): Vec3 {
    const l = this.length();
    return l > 0 ? this.scale(1 / l) : new Vec3();
  }

  distanceTo(v: Vec3): number {
    return this.sub(v).length();
  }

  /** Angolo tra due vettori [rad]. */
  angleTo(v: Vec3): number {
    const d = this.length() * v.length();
    if (d === 0) return 0;
    return Math.acos(Math.min(1, Math.max(-1, this.dot(v) / d)));
  }

  /** this += v * s */
  addScaledInPlace(v: Vec3, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  toString(digits = 4): string {
    return `(${this.x.toExponential(digits)}, ${this.y.toExponential(digits)}, ${this.z.toExponential(digits)})`;
  }
}
