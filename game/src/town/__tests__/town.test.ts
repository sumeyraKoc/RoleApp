import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findPath, type PathfindingGrid } from "../../engine/PathFinder";
import { Block } from "../blocks";
import { buildMeshData } from "../mesher";
import { buildTown, GROUND_Y, isInsideBuilding, isUpperBlock, propAt } from "../townMap";
import { VoxelWorld } from "../VoxelWorld";

const everywhere = () => true;

describe("VoxelWorld", () => {
  it("treats out-of-bounds as air", () => {
    const w = new VoxelWorld(2, 2, 2);
    expect(w.get(-1, 0, 0)).toBe(Block.AIR);
    expect(w.get(5, 5, 5)).toBe(Block.AIR);
  });

  it("needs walkable ground and two free blocks to stand", () => {
    const w = new VoxelWorld(3, 5, 3);
    w.fill(0, 1, 0, 2, 1, 2, Block.GRASS);
    expect(w.isStandable(1, 1)).toBe(true);
    w.set(1, 3, 1, Block.PLANKS);
    expect(w.isStandable(1, 1)).toBe(false);
    w.set(2, 1, 2, Block.WATER);
    expect(w.isStandable(2, 2)).toBe(false);
  });
});

describe("mesher", () => {
  it("emits six faces for a lone block", () => {
    const w = new VoxelWorld(3, 3, 3);
    w.set(1, 1, 1, Block.BRICK);
    const mesh = buildMeshData(w, everywhere);
    expect(mesh.faceCount).toBe(6);
    expect(mesh.indices.length).toBe(36);
    expect(mesh.positions.length).toBe(6 * 4 * 3);
  });

  it("culls the shared face between two opaque blocks", () => {
    const w = new VoxelWorld(3, 3, 3);
    w.set(0, 1, 1, Block.BRICK);
    w.set(1, 1, 1, Block.BRICK);
    expect(buildMeshData(w, everywhere).faceCount).toBe(10);
  });

  it("keeps the opaque face behind glass", () => {
    const w = new VoxelWorld(3, 3, 3);
    w.set(0, 1, 1, Block.BRICK);
    w.set(1, 1, 1, Block.GLASS);
    // brick keeps all 6 faces (seen through glass); glass drops the face pressed against brick
    expect(buildMeshData(w, everywhere).faceCount).toBe(11);
  });

  it("treats blocks outside the region as air so cut-away edges stay closed", () => {
    const w = new VoxelWorld(3, 3, 3);
    w.set(1, 0, 1, Block.BRICK);
    w.set(1, 1, 1, Block.BRICK);
    const lower = buildMeshData(w, (_x, y) => y < 1);
    expect(lower.faceCount).toBe(6);
  });
});

describe("town map", () => {
  const town = buildTown();
  const { world } = town;
  const npcCells = new Set(town.npcs.map((n) => `${n.cell.x},${n.cell.z}`));
  const grid: PathfindingGrid = {
    width: world.width,
    height: world.depth,
    isWalkable: (x, z) => world.isStandable(x, z, GROUND_Y) && !npcCells.has(`${x},${z}`),
  };
  const spawn = { x: town.spawn.x, y: town.spawn.z };

  it("spawns the player on a standable cell", () => {
    expect(grid.isWalkable(spawn.x, spawn.y)).toBe(true);
  });

  it("can walk through every door", () => {
    for (const b of town.buildings) {
      const path = findPath(grid, spawn, { x: b.door.x, y: b.door.z });
      expect(path, `door of ${b.id}`).not.toBeNull();
    }
  });

  it("can reach talking range of every NPC", () => {
    for (const npc of town.npcs) {
      let reachable = false;
      for (let dz = -2; dz <= 2 && !reachable; dz++) {
        for (let dx = -2; dx <= 2 && !reachable; dx++) {
          const x = npc.cell.x + dx;
          const z = npc.cell.z + dz;
          if (!grid.isWalkable(x, z)) continue;
          reachable = findPath(grid, spawn, { x, y: z }) !== null;
        }
      }
      expect(reachable, `NPC ${npc.id}`).toBe(true);
    }
  });

  it("places every NPC inside its building", () => {
    for (const npc of town.npcs) {
      const building = town.buildings.find((b) => b.id === npc.buildingId);
      expect(building, npc.id).toBeDefined();
      if (building) expect(isInsideBuilding(building, npc.cell.x, npc.cell.z)).toBe(true);
    }
  });

  it("opens the dub shop from CD shelves you can walk up to", () => {
    const shop = town.buildings.find((b) => b.id === "studio");
    expect(shop?.activity?.id).toBe("dub");
    expect(shop?.activity?.key).toBe("K");
    expect(shop?.portal).toBe(undefined);
    const anchors = shop?.activity?.anchors ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(world.get(a.x, a.y, a.z)).toBe(Block.CD_SHELF);
    const reachable = anchors.some((a) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
        const x = a.x + (dx ?? 0);
        const z = a.z + (dz ?? 0);
        return grid.isWalkable(x, z) && findPath(grid, spawn, { x, y: z }) !== null;
      }),
    );
    expect(reachable).toBe(true);
  });

  it("uses only backend scenarios that exist", () => {
    expect(town.npcs.map((n) => `${n.location}/${n.npcRole}`).sort()).toEqual([
      "bakery/baker",
      "cafe/barista",
      "library/librarian",
      "town/friend",
    ]);
  });

  it("splits every block into exactly one mesh region", () => {
    const upperOwners = (x: number, y: number, z: number) =>
      town.buildings.filter((b) => isUpperBlock(b, x, y, z)).length;
    for (let y = 0; y < world.height; y++) {
      for (let z = 0; z < world.depth; z++) {
        for (let x = 0; x < world.width; x++) {
          if (world.get(x, y, z) === Block.AIR) continue;
          expect(upperOwners(x, y, z)).toBeLessThanOrEqual(1);
        }
      }
    }
    const base = buildMeshData(world, (x, y, z) => upperOwners(x, y, z) === 0);
    expect(base.faceCount).toBeGreaterThan(1000);
  });

  it("builds every vocabulary prop from real blocks inside its building", () => {
    for (const prop of town.props) {
      const building = town.buildings.find((b) => b.id === prop.buildingId);
      expect(building, prop.id).toBeDefined();
      for (const b of prop.blocks) {
        expect(world.get(b.x, b.y, b.z) !== Block.AIR, `${prop.id} block ${b.x},${b.y},${b.z}`).toBe(true);
        if (building) expect(isInsideBuilding(building, b.x, b.z), prop.id).toBe(true);
        expect(propAt(town.props, b.x, b.y, b.z)?.id).toBe(prop.id);
      }
    }
  });

  it("can stand next to every vocabulary prop", () => {
    for (const prop of town.props) {
      const reachable = prop.blocks.some((b) =>
        [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
          const x = b.x + (dx ?? 0);
          const z = b.z + (dz ?? 0);
          return grid.isWalkable(x, z) && findPath(grid, spawn, { x, y: z }) !== null;
        }),
      );
      expect(reachable, prop.id).toBe(true);
    }
  });

  it("uses concepts that exist in the backend vocabulary files", () => {
    for (const prop of town.props) {
      const url = resolve(__dirname, `../../../../api/game_data/vocabulary/${prop.location}.json`);
      const vocab = JSON.parse(readFileSync(url, "utf-8")) as { concepts: Array<{ concept: string }> };
      expect(vocab.concepts.some((c) => c.concept === prop.concept), `${prop.location}/${prop.concept}`).toBe(true);
    }
  });
});
