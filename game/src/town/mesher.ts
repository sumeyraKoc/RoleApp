import { ATLAS_COLUMNS, Block, getBlockDef } from "./blocks";
import { VoxelWorld } from "./VoxelWorld";

/**
 * Turns blocks into one triangle list per region (face culling + simple corner AO).
 * Pure data, no three.js, so it runs in unit tests. TownRenderer wraps it in a BufferGeometry.
 */

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Linear-space vertex colours used as flat Minecraft-style face shading. */
  colors: Float32Array;
  indices: Uint32Array;
  faceCount: number;
}

export type RegionTest = (x: number, y: number, z: number) => boolean;

type Corner = readonly [px: number, py: number, pz: number, u: number, v: number];

interface FaceDef {
  dir: readonly [number, number, number];
  shade: number;
  corners: readonly [Corner, Corner, Corner, Corner];
}

const FACES: readonly FaceDef[] = [
  { dir: [-1, 0, 0], shade: 0.78, corners: [[0, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1], [0, 0, 1, 1, 0]] },
  { dir: [1, 0, 0], shade: 0.78, corners: [[1, 1, 1, 0, 1], [1, 0, 1, 0, 0], [1, 1, 0, 1, 1], [1, 0, 0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.5, corners: [[1, 0, 1, 1, 0], [0, 0, 1, 0, 0], [1, 0, 0, 1, 1], [0, 0, 0, 0, 1]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 1, 1, 1], [1, 1, 1, 0, 1], [0, 1, 0, 1, 0], [1, 1, 0, 0, 0]] },
  { dir: [0, 0, -1], shade: 0.64, corners: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [1, 1, 0, 0, 1], [0, 1, 0, 1, 1]] },
  { dir: [0, 0, 1], shade: 0.64, corners: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [0, 1, 1, 0, 1], [1, 1, 1, 1, 1]] },
];

const UV_INSET = 0.002;
const toLinear = (srgb: number) => Math.pow(srgb, 2.2);

export function buildMeshData(world: VoxelWorld, inRegion: RegionTest): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const ind: number[] = [];
  let faceCount = 0;

  const solidInRegion = (x: number, y: number, z: number) => inRegion(x, y, z) && world.isOpaque(x, y, z);
  const rows = ATLAS_COLUMNS;

  for (let y = 0; y < world.height; y++) {
    for (let z = 0; z < world.depth; z++) {
      for (let x = 0; x < world.width; x++) {
        const id = world.get(x, y, z);
        if (id === Block.AIR || !inRegion(x, y, z)) continue;
        const def = getBlockDef(id);
        if (!def) continue;

        for (const face of FACES) {
          const [dx, dy, dz] = face.dir;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          let neighbour = world.get(nx, ny, nz);
          if (neighbour !== Block.AIR && !inRegion(nx, ny, nz)) neighbour = Block.AIR;
          if (neighbour !== Block.AIR) {
            const nDef = getBlockDef(neighbour);
            const seeThrough = (nDef?.transparent ?? false) && neighbour !== id;
            if (!seeThrough) continue;
          }

          const tile = dy > 0 ? def.top : dy < 0 ? def.bottom : def.side;
          const tc = tile % ATLAS_COLUMNS;
          const tr = Math.floor(tile / ATLAS_COLUMNS);
          const base = pos.length / 3;

          for (const [px, py, pz, cu, cv] of face.corners) {
            pos.push(x + px, y + py, z + pz);
            nrm.push(dx, dy, dz);
            uv.push(
              (tc + (cu ? 1 - UV_INSET : UV_INSET)) / ATLAS_COLUMNS,
              1 - (tr + (cv ? UV_INSET : 1 - UV_INSET)) / rows,
            );
            let ao = 1;
            if (dy > 0) {
              const sx = px ? x + 1 : x - 1;
              const sz = pz ? z + 1 : z - 1;
              const s1 = solidInRegion(sx, y + 1, z);
              const s2 = solidInRegion(x, y + 1, sz);
              const s3 = solidInRegion(sx, y + 1, sz);
              ao = 1 - 0.14 * ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (s3 && !(s1 && s2) ? 1 : 0));
            } else if (dy === 0 && py === 0) {
              ao = 0.86;
            }
            const c = toLinear(face.shade * ao);
            col.push(c, c, c);
          }
          ind.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
          faceCount++;
        }
      }
    }
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    uvs: new Float32Array(uv),
    colors: new Float32Array(col),
    indices: new Uint32Array(ind),
    faceCount,
  };
}
