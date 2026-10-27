import { Block, getBlockDef } from "./blocks";

/**
 * Dense block grid. Axes: x (east), y (up), z (south). Ground surface is y = 1,
 * so characters stand at y = 2 and need two free blocks (y = 2 and y = 3).
 */
export class VoxelWorld {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, depth: number) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.data = new Uint8Array(width * height * depth);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.height && z < this.depth;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return Block.AIR;
    return this.data[this.index(x, y, z)] ?? Block.AIR;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (this.inBounds(x, y, z)) this.data[this.index(x, y, z)] = id;
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, id);
      }
    }
  }

  isOpaque(x: number, y: number, z: number): boolean {
    const id = this.get(x, y, z);
    if (id === Block.AIR) return false;
    return !(getBlockDef(id)?.transparent ?? false);
  }

  /** True when a character can stand on column (x, z): walkable ground and two free blocks above. */
  isStandable(x: number, z: number, groundY = 1): boolean {
    const ground = getBlockDef(this.get(x, groundY, z));
    if (!ground || !ground.walkable) return false;
    return this.get(x, groundY + 1, z) === Block.AIR && this.get(x, groundY + 2, z) === Block.AIR;
  }

  countBlocks(): number {
    let n = 0;
    for (const v of this.data) if (v !== Block.AIR) n++;
    return n;
  }

  private index(x: number, y: number, z: number): number {
    return (y * this.depth + z) * this.width + x;
  }
}
