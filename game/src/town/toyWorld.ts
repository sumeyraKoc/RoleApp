import * as THREE from "three";
import { Block, getBlockDef } from "./blocks";
import type { RegionTest } from "./mesher";
import { GROUND_Y, type BuildingSpec, type TownDefinition } from "./townMap";

/**
 * The "toy town" look. Gameplay still runs on the block grid (walking, tapping,
 * props, gates); this module only draws it differently:
 * flat-coloured lit surfaces instead of pixel textures, real sloped roofs instead
 * of stepped ones, round low-poly trees and bushes, animated water, softly blended
 * ground colours and a scatter of grass tufts and flowers. Everything is made in
 * code, so there are no asset files and no licensing questions.
 */

type Rgb = THREE.Color;

const hex = (h: string) => new THREE.Color(h);

const TOP: Partial<Record<number, Rgb>> = {
  [Block.GRASS]: hex("#86c565"),
  [Block.DIRT]: hex("#9c7652"),
  [Block.COBBLE]: hex("#e2d3b4"),
  [Block.PLANKS]: hex("#d29a5f"),
  [Block.LOG]: hex("#a0704a"),
  [Block.BRICK]: hex("#d0715a"),
  [Block.GLASS]: hex("#cdeefb"),
  [Block.PLASTER]: hex("#f6ead2"),
  [Block.ROOF]: hex("#dd6a4c"),
  [Block.AWNING]: hex("#f4efe4"),
  [Block.SHELF]: hex("#a46b43"),
  [Block.WATER]: hex("#56b5e3"),
  [Block.DARK]: hex("#5a5f78"),
  [Block.CD_SHELF]: hex("#5a5f78"),
  [Block.SAND]: hex("#f0dfac"),
  [Block.BED]: hex("#ec8a9b"),
  [Block.STONE]: hex("#c4c7d0"),
  [Block.CRYSTAL]: hex("#9ff6ff"),
  [Block.RUNE]: hex("#b9b3d8"),
  [Block.MOSS]: hex("#7fb26a"),
};

const SIDE: Partial<Record<number, Rgb>> = {
  [Block.GRASS]: hex("#9c7652"),
  [Block.LOG]: hex("#8a5b39"),
  [Block.SHELF]: hex("#7d4f33"),
  [Block.CD_SHELF]: hex("#7a63b0"),
  [Block.BED]: hex("#c99a6b"),
  [Block.RUNE]: hex("#8f7cff"),
  [Block.MOSS]: hex("#b0b4bf"),
};

const AWNING_STRIPE = hex("#e2574c");
const FALLBACK = hex("#c8c8c8");
const TRANSPARENT_BLOCKS = new Set<number>([Block.GLASS, Block.CRYSTAL]);

const LEAF_COLORS = ["#5fae4e", "#4f9e45", "#74bd5a", "#68b552"].map(hex);
const FLOWER_COLORS = ["#ff8fb1", "#ffd45c", "#ffffff", "#b99cff", "#ff9a5c"].map(hex);

const WATER_DEPTH = 0.8;

interface Face {
  dir: readonly [number, number, number];
  corners: readonly (readonly [number, number, number])[];
}

const FACES: readonly Face[] = [
  { dir: [-1, 0, 0], corners: [[0, 1, 0], [0, 0, 0], [0, 1, 1], [0, 0, 1]] },
  { dir: [1, 0, 0], corners: [[1, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0, 0]] },
  { dir: [0, -1, 0], corners: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]] },
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]] },
  { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] },
];

/** Stable pseudo-random number in [0, 1) for a cell. */
function hash(x: number, y: number, z: number, salt = 0): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + z * 2147483647 + salt * 1274126177, 1);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface Tree {
  x: number;
  z: number;
}

/** What the plain block pass must leave out because something nicer draws it. */
interface Analysis {
  skip: Uint8Array;
  trees: Tree[];
  bushes: Array<{ x: number; y: number; z: number }>;
  roofs: BuildingSpec[];
}

class GeometryBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  quad(corners: ReadonlyArray<readonly [number, number, number]>, normal: readonly [number, number, number], colors: Rgb[]): void {
    const base = this.pos.length / 3;
    corners.forEach((c, i) => {
      this.pos.push(c[0], c[1], c[2]);
      this.nrm.push(normal[0], normal[1], normal[2]);
      const k = colors[i] ?? colors[0] ?? FALLBACK;
      this.col.push(k.r, k.g, k.b);
    });
    this.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  /** A flat triangle or quad given in order around its edge (normal computed). */
  poly(points: THREE.Vector3[], color: Rgb): void {
    const [a, b, c] = points as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const base = this.pos.length / 3;
    for (const p of points) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
    }
    for (let i = 1; i < points.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

export class ToyWorld {
  private readonly solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly roofMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private readonly glassMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
  });
  private readonly glowMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, opacity: 0.85, emissive: new THREE.Color("#5fd8ff"), emissiveIntensity: 0.6,
  });
  private readonly blobMaterial = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly trunkMaterial = new THREE.MeshLambertMaterial({ color: "#8a5b39", flatShading: true });
  private readonly decorMaterial = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly waterUniforms = { uTime: { value: 0 } };
  private readonly waterMaterial: THREE.MeshLambertMaterial;
  private readonly blobGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly trunkGeometry = new THREE.CylinderGeometry(0.15, 0.24, 1, 7);
  private readonly tuftGeometry = new THREE.ConeGeometry(0.07, 0.32, 4);
  private readonly petalGeometry = new THREE.IcosahedronGeometry(0.09, 0);

  constructor(private readonly town: TownDefinition) {
    this.trunkGeometry.translate(0, 0.5, 0);
    this.tuftGeometry.translate(0, 0.16, 0);
    this.waterMaterial = new THREE.MeshLambertMaterial({
      color: "#43a9e0", transparent: true, opacity: 0.82, depthWrite: false, emissive: new THREE.Color("#0b3a5c"),
    });
    const uniforms = this.waterUniforms;
    this.waterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms["uTime"] = uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;\nvarying float vWave;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           float wave = sin(uTime * 1.4 + position.x * 0.9 + position.z * 0.6) * 0.5
                      + sin(uTime * 0.9 - position.x * 0.4 + position.z * 1.1) * 0.5;
           transformed.y += wave * 0.035;
           vWave = wave;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vWave;")
        .replace(
          "#include <dithering_fragment>",
          "#include <dithering_fragment>\ngl_FragColor.rgb += vec3(0.07, 0.09, 0.1) * smoothstep(0.55, 1.0, vWave);",
        );
    };
  }

  /** Advance the water animation. */
  update(seconds: number): void {
    this.waterUniforms.uTime.value = seconds;
  }

  /** Everything visible for one region of the world (the town minus building tops, or one building's top). */
  build(inRegion: RegionTest, withDecor: boolean): THREE.Group {
    const group = new THREE.Group();
    const info = this.analyse();
    const { world } = this.town;
    const skipAt = (x: number, y: number, z: number) =>
      world.inBounds(x, y, z) && info.skip[(y * world.depth + z) * world.width + x] === 1;

    const solid = new GeometryBuilder();
    const clear = new GeometryBuilder();
    const glow = new GeometryBuilder();
    const water = new GeometryBuilder();

    for (let y = 0; y < world.height; y++) {
      for (let z = 0; z < world.depth; z++) {
        for (let x = 0; x < world.width; x++) {
          const id = world.get(x, y, z);
          if (id === Block.AIR || !inRegion(x, y, z)) continue;
          if (id === Block.WATER) {
            this.addWater(water, x, y, z);
            continue;
          }
          if (skipAt(x, y, z)) continue;
          const target = id === Block.CRYSTAL ? glow : TRANSPARENT_BLOCKS.has(id) ? clear : solid;
          this.addBlockFaces(target, id, x, y, z, inRegion, skipAt);
        }
      }
    }

    const add = (builder: GeometryBuilder, material: THREE.Material, cast: boolean) => {
      if (builder.empty) return;
      const mesh = new THREE.Mesh(builder.geometry(), material);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    add(solid, this.solidMaterial, true);
    add(water, this.waterMaterial, false);
    add(clear, this.glassMaterial, false);
    add(glow, this.glowMaterial, false);

    const roofs = new GeometryBuilder();
    for (const b of info.roofs) {
      if (b.roof && inRegion(b.x0, b.roof.y, b.z0)) this.addRoof(roofs, b);
    }
    if (!roofs.empty) {
      const mesh = new THREE.Mesh(roofs.geometry(), this.roofMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    this.addPlants(group, info, inRegion);
    if (withDecor) this.addDecor(group, inRegion, skipAt);
    return group;
  }

  // ------------------------------------------------------------------ analysis

  private analyse(): Analysis {
    const { world, buildings } = this.town;
    const skip = new Uint8Array(world.width * world.height * world.depth);
    const mark = (x: number, y: number, z: number) => {
      if (world.inBounds(x, y, z)) skip[(y * world.depth + z) * world.width + x] = 1;
    };

    // Sloped roofs replace the stepped roof layers.
    const roofs = buildings.filter((b) => b.roof);
    for (const b of roofs) {
      const roof = b.roof!;
      for (let y = roof.y; y < world.height; y++) {
        for (let z = b.z0 - 1; z <= b.z1 + 1; z++) {
          for (let x = b.x0 - 1; x <= b.x1 + 1; x++) if (world.get(x, y, z) === roof.block) mark(x, y, z);
        }
      }
    }

    // Trees: a log trunk (y 2..5) with leaves right above it.
    const trees: Tree[] = [];
    for (let z = 0; z < world.depth; z++) {
      for (let x = 0; x < world.width; x++) {
        let trunk = true;
        for (let y = 2; y <= 5; y++) if (world.get(x, y, z) !== Block.LOG) trunk = false;
        if (!trunk || world.get(x, 6, z) !== Block.LEAVES) continue;
        trees.push({ x, z });
        for (let y = 2; y <= 5; y++) mark(x, y, z);
        for (let y = 5; y <= 8; y++) {
          for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) if (world.get(x + dx, y, z + dz) === Block.LEAVES) mark(x + dx, y, z + dz);
          }
        }
      }
    }

    // Any other leaves become round bushes.
    const bushes: Analysis["bushes"] = [];
    for (let y = 0; y < world.height; y++) {
      for (let z = 0; z < world.depth; z++) {
        for (let x = 0; x < world.width; x++) {
          if (world.get(x, y, z) !== Block.LEAVES) continue;
          if (skip[(y * world.depth + z) * world.width + x]) continue;
          bushes.push({ x, y, z });
          mark(x, y, z);
        }
      }
    }
    return { skip, trees, bushes, roofs };
  }

  // ------------------------------------------------------------------ blocks

  private colorFor(id: number, dy: number, x: number, y: number, z: number): Rgb {
    let c = (dy > 0 || dy < 0 ? TOP[id] : SIDE[id] ?? TOP[id]) ?? FALLBACK;
    if (id === Block.AWNING && (x + z) % 2 === 0) c = AWNING_STRIPE;
    // Soft per-block variation keeps big walls and lawns from looking flat.
    const v = 0.95 + hash(x, y, z) * 0.08;
    return c.clone().multiplyScalar(v);
  }

  private addBlockFaces(
    out: GeometryBuilder, id: number, x: number, y: number, z: number,
    inRegion: RegionTest, skipAt: (x: number, y: number, z: number) => boolean,
  ): void {
    const { world } = this.town;
    const opaqueAt = (ax: number, ay: number, az: number) => {
      if (!inRegion(ax, ay, az) || skipAt(ax, ay, az)) return false;
      const n = world.get(ax, ay, az);
      return n !== Block.AIR && n !== Block.WATER && !(getBlockDef(n)?.transparent ?? false);
    };
    for (const face of FACES) {
      const [dx, dy, dz] = face.dir;
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      let n = world.get(nx, ny, nz);
      if (n !== Block.AIR && (!inRegion(nx, ny, nz) || skipAt(nx, ny, nz))) n = Block.AIR;
      if (n !== Block.AIR && n !== Block.WATER) {
        const transparent = getBlockDef(n)?.transparent ?? false;
        if (!transparent || n === id) continue;
      }
      const colors: Rgb[] = [];
      for (const [px, py, pz] of face.corners) {
        let c: Rgb;
        if (dy > 0 && (y === GROUND_Y || y === 0)) {
          // Ground: blend the four cells around each corner so paths, sand and grass fade into each other.
          c = this.groundCorner(x + px, y, z + pz);
        } else {
          c = this.colorFor(id, dy, x, y, z);
        }
        let ao = 1;
        if (dy > 0) {
          const sx = px ? x + 1 : x - 1;
          const sz = pz ? z + 1 : z - 1;
          const s1 = opaqueAt(sx, y + 1, z);
          const s2 = opaqueAt(x, y + 1, sz);
          const s3 = opaqueAt(sx, y + 1, sz);
          ao = 1 - 0.13 * ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (s3 && !(s1 && s2) ? 1 : 0));
        } else if (dy === 0 && py === 0) {
          ao = 0.88;
        }
        colors.push(ao === 1 ? c : c.clone().multiplyScalar(ao));
      }
      out.quad(face.corners.map(([px, py, pz]) => [x + px, y + py, z + pz] as const), face.dir, colors);
    }
  }

  private groundCorner(cx: number, y: number, cz: number): Rgb {
    const { world } = this.town;
    const sum = new THREE.Color(0, 0, 0);
    let n = 0;
    for (const [ox, oz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const x = cx + ox;
      const z = cz + oz;
      const id = world.get(x, y, z);
      if (id === Block.AIR || id === Block.WATER) continue;
      const above = world.get(x, y + 1, z);
      if (above !== Block.AIR && above !== Block.WATER && above !== Block.LEAVES && !(getBlockDef(above)?.transparent)) {
        // Under a wall: don't pull wall-base colours into the lawn.
        if (y === GROUND_Y && above !== Block.LOG) continue;
      }
      sum.add(this.colorFor(id, 1, x, y, z));
      n++;
    }
    return n ? sum.multiplyScalar(1 / n) : FALLBACK;
  }

  private addWater(out: GeometryBuilder, x: number, y: number, z: number): void {
    const { world } = this.town;
    const top = y + WATER_DEPTH;
    const c = TOP[Block.WATER]!;
    if (world.get(x, y + 1, z) !== Block.WATER) {
      out.quad([[x, top, z + 1], [x + 1, top, z + 1], [x, top, z], [x + 1, top, z]], [0, 1, 0], [c]);
    }
    // Close the water at the edge of the map.
    if (x === 0) out.quad([[x, top, z], [x, y, z], [x, top, z + 1], [x, y, z + 1]], [-1, 0, 0], [c]);
    if (x === world.width - 1) out.quad([[x + 1, top, z + 1], [x + 1, y, z + 1], [x + 1, top, z], [x + 1, y, z]], [1, 0, 0], [c]);
    if (z === 0) out.quad([[x + 1, y, z], [x, y, z], [x + 1, top, z], [x, top, z]], [0, 0, -1], [c]);
    if (z === world.depth - 1) out.quad([[x, y, z + 1], [x + 1, y, z + 1], [x, top, z + 1], [x + 1, top, z + 1]], [0, 0, 1], [c]);
  }

  // ------------------------------------------------------------------ roofs

  /** A hip roof over the building, with tile rows and a thin fascia. */
  private addRoof(out: GeometryBuilder, b: BuildingSpec): void {
    const roof = b.roof!;
    const base = (TOP[roof.block] ?? FALLBACK).clone();
    // A market tent roof gets red and cream stripes; other roofs get two shades of tile rows.
    const darker = roof.block === Block.AWNING ? AWNING_STRIPE.clone() : base.clone().multiplyScalar(0.86);
    const fascia = base.clone().multiplyScalar(0.62);
    const o = 0.15;
    const xa = b.x0 - 1 - o;
    const xb = b.x1 + 2 + o;
    const za = b.z0 - 1 - o;
    const zb = b.z1 + 2 + o;
    const w = xb - xa;
    const d = zb - za;
    const eave = roof.y;
    const rise = Math.max(1.4, Math.min(w, d) * (roof.pitch ?? 0.42));
    const top = eave + rise;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    let r1: THREE.Vector3;
    let r2: THREE.Vector3;
    if (w >= d) {
      const zm = (za + zb) / 2;
      r1 = V(xa + d / 2, top, zm);
      r2 = V(xb - d / 2, top, zm);
    } else {
      const xm = (xa + xb) / 2;
      r1 = V(xm, top, za + w / 2);
      r2 = V(xm, top, zb - w / 2);
    }
    const A = V(xa, eave, za);
    const B = V(xb, eave, za);
    const C = V(xb, eave, zb);
    const D = V(xa, eave, zb);

    // Slopes as rows of tiles: alternate shades from eave to ridge.
    const rows = 5;
    const slope = (e1: THREE.Vector3, e2: THREE.Vector3, t2: THREE.Vector3, t1: THREE.Vector3) => {
      for (let i = 0; i < rows; i++) {
        const a = i / rows;
        const c = (i + 1) / rows;
        const p1 = e1.clone().lerp(t1, a);
        const p2 = e2.clone().lerp(t2, a);
        const p3 = e2.clone().lerp(t2, c);
        const p4 = e1.clone().lerp(t1, c);
        const color = i % 2 === 0 ? base : darker;
        if (p3.distanceTo(p4) < 1e-4) out.poly([p1, p2, p3], color);
        else out.poly([p1, p2, p3, p4], color);
      }
    };
    if (w >= d) {
      slope(A, B, r2, r1); // north
      slope(C, D, r1, r2); // south
      slope(B, C, r2, r2); // east (triangle)
      slope(D, A, r1, r1); // west
    } else {
      slope(D, A, r1, r2); // west
      slope(B, C, r2, r1); // east
      slope(A, B, r1, r1); // north (triangle)
      slope(C, D, r2, r2); // south
    }
    // Fascia: a thin band under the eaves so the roof has some thickness.
    const t = 0.22;
    const low = (p: THREE.Vector3) => V(p.x, p.y - t, p.z);
    for (const [p, q] of [[A, B], [B, C], [C, D], [D, A]] as const) out.poly([low(p), low(q), q, p], fascia);
    out.poly([low(A), low(D), low(C), low(B)], fascia);
  }

  // ------------------------------------------------------------------ plants

  private addPlants(group: THREE.Group, info: Analysis, inRegion: RegionTest): void {
    const trees = info.trees.filter((t) => inRegion(t.x, 2, t.z));
    const bushes = info.bushes.filter((b) => inRegion(b.x, b.y, b.z));
    const blobs: Array<{ p: THREE.Vector3; s: THREE.Vector3; r: number; c: Rgb }> = [];
    const leaf = (x: number, y: number, z: number, salt: number) =>
      LEAF_COLORS[Math.floor(hash(x, y, z, salt) * LEAF_COLORS.length)] ?? LEAF_COLORS[0]!;

    for (const t of trees) {
      const cx = t.x + 0.5;
      const cz = t.z + 0.5;
      const big = 1.75 + hash(t.x, 0, t.z, 3) * 0.35;
      blobs.push({ p: new THREE.Vector3(cx, 6.6, cz), s: new THREE.Vector3(big, big * 0.85, big), r: hash(t.x, 1, t.z), c: leaf(t.x, 0, t.z, 1) });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + hash(t.x, i, t.z, 5) * 1.2;
        const s = 1.0 + hash(t.x, i, t.z, 7) * 0.35;
        blobs.push({
          p: new THREE.Vector3(cx + Math.cos(a) * 0.95, 6.1 + hash(t.x, i, t.z, 9) * 0.9, cz + Math.sin(a) * 0.95),
          s: new THREE.Vector3(s, s * 0.9, s), r: hash(t.x, i, t.z, 11), c: leaf(t.x, i, t.z, 13),
        });
      }
      blobs.push({ p: new THREE.Vector3(cx, 7.9, cz), s: new THREE.Vector3(1.05, 0.95, 1.05), r: hash(t.x, 4, t.z), c: leaf(t.x, 4, t.z, 2) });
    }
    for (const b of bushes) {
      const s = 0.62 + hash(b.x, b.y, b.z, 3) * 0.12;
      blobs.push({ p: new THREE.Vector3(b.x + 0.5, b.y + 0.48, b.z + 0.5), s: new THREE.Vector3(s, s * 0.85, s), r: hash(b.x, b.y, b.z), c: leaf(b.x, b.y, b.z, 1) });
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    if (blobs.length) {
      const mesh = new THREE.InstancedMesh(this.blobGeometry, this.blobMaterial, blobs.length);
      blobs.forEach((b, i) => {
        q.setFromEuler(new THREE.Euler(0, b.r * Math.PI * 2, 0));
        mesh.setMatrixAt(i, m.compose(b.p, q, b.s));
        mesh.setColorAt(i, b.c);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (trees.length) {
      const mesh = new THREE.InstancedMesh(this.trunkGeometry, this.trunkMaterial, trees.length);
      trees.forEach((t, i) => {
        q.setFromEuler(new THREE.Euler(0, hash(t.x, 2, t.z) * Math.PI, 0));
        mesh.setMatrixAt(i, m.compose(new THREE.Vector3(t.x + 0.5, 2, t.z + 0.5), q, new THREE.Vector3(1, 4.6, 1)));
      });
      mesh.castShadow = true;
      group.add(mesh);
    }
  }

  /** Grass tufts and little flowers on open lawn (decoration only, not clickable). */
  private addDecor(group: THREE.Group, inRegion: RegionTest, skipAt: (x: number, y: number, z: number) => boolean): void {
    const { world } = this.town;
    const tufts: Array<{ p: THREE.Vector3; r: number; s: number; c: Rgb }> = [];
    const flowers: Array<{ p: THREE.Vector3; c: Rgb }> = [];
    const y = GROUND_Y;
    for (let z = 0; z < world.depth; z++) {
      for (let x = 0; x < world.width; x++) {
        if (world.get(x, y, z) !== Block.GRASS || !inRegion(x, y, z)) continue;
        const above = world.get(x, y + 1, z);
        if (above !== Block.AIR && !skipAt(x, y + 1, z)) continue;
        const roll = hash(x, y, z, 21);
        if (roll < 0.22) {
          const n = 2 + Math.floor(hash(x, y, z, 22) * 3);
          for (let i = 0; i < n; i++) {
            tufts.push({
              p: new THREE.Vector3(x + 0.2 + hash(x, i, z, 23) * 0.6, y + 1, z + 0.2 + hash(x, i, z, 24) * 0.6),
              r: hash(x, i, z, 25), s: 0.7 + hash(x, i, z, 26) * 0.6,
              c: (LEAF_COLORS[i % LEAF_COLORS.length] ?? LEAF_COLORS[0]!).clone().multiplyScalar(0.9),
            });
          }
        } else if (roll < 0.29) {
          const c = FLOWER_COLORS[Math.floor(hash(x, y, z, 27) * FLOWER_COLORS.length)] ?? FLOWER_COLORS[0]!;
          for (let i = 0; i < 3; i++) {
            flowers.push({ p: new THREE.Vector3(x + 0.25 + hash(x, i, z, 28) * 0.5, y + 1.12, z + 0.25 + hash(x, i, z, 29) * 0.5), c });
          }
        }
      }
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    if (tufts.length) {
      const mesh = new THREE.InstancedMesh(this.tuftGeometry, this.decorMaterial, tufts.length);
      tufts.forEach((t, i) => {
        q.setFromEuler(new THREE.Euler((t.r - 0.5) * 0.5, t.r * Math.PI * 2, (hash(i, 0, 0) - 0.5) * 0.5));
        mesh.setMatrixAt(i, m.compose(t.p, q, new THREE.Vector3(1, t.s, 1)));
        mesh.setColorAt(i, t.c);
      });
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (flowers.length) {
      const mesh = new THREE.InstancedMesh(this.petalGeometry, this.decorMaterial, flowers.length);
      flowers.forEach((f, i) => {
        mesh.setMatrixAt(i, m.compose(f.p, q.identity(), new THREE.Vector3(1, 0.7, 1)));
        mesh.setColorAt(i, f.c);
      });
      group.add(mesh);
    }
  }
}
