import * as THREE from "three";

/**
 * A burst of glowing motes rising from a set of blocks (a rune gate opening, a
 * spell landing). Additive points drawn in code: no textures or assets.
 */
export class MagicBurst {
  readonly points: THREE.Points;
  private readonly velocities: Float32Array;
  private age = 0;

  constructor(blocks: readonly { x: number; y: number; z: number }[], color = 0x8ff3ff, perBlock = 14) {
    const count = Math.max(1, blocks.length * perBlock);
    const positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    let i = 0;
    for (const b of blocks) {
      for (let k = 0; k < perBlock; k++, i++) {
        positions[i * 3] = b.x + Math.random();
        positions[i * 3 + 1] = b.y + Math.random();
        positions[i * 3 + 2] = b.z + Math.random();
        this.velocities[i * 3] = (Math.random() - 0.5) * 1.2;
        this.velocities[i * 3 + 1] = 0.8 + Math.random() * 1.8;
        this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color, size: 0.22, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.points = new THREE.Points(geometry, material);
  }

  /** Advance the burst; returns false once it has faded and can be removed. */
  update(dt: number): boolean {
    this.age += dt;
    const position = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = position.array as Float32Array;
    for (let i = 0; i < array.length; i++) array[i] = (array[i] ?? 0) + (this.velocities[i] ?? 0) * dt;
    position.needsUpdate = true;
    const material = this.points.material as THREE.PointsMaterial;
    material.opacity = Math.max(0, 1 - this.age / 2.2);
    return this.age < 2.2;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
