import { describe, expect, it } from "vitest";
import { findPath, type PathfindingGrid } from "../../engine/PathFinder";
import { Block } from "../blocks";
import { buildTown, GROUND_Y, isInsideBuilding, MEETING_PLACES } from "../townMap";

describe("Kademe 2 map", () => {
  const town = buildTown();
  const { world } = town;
  const grid: PathfindingGrid = {
    width: world.width,
    height: world.depth,
    isWalkable: (x, z) => world.isStandable(x, z, GROUND_Y),
  };
  const spawn = { x: town.spawn.x, y: town.spawn.z };

  it("starts the player right outside home", () => {
    const home = town.buildings.find((b) => b.id === "home");
    expect(home).toBeDefined();
    expect(findPath(grid, spawn, { x: home!.door.x, y: home!.door.z })).not.toBeNull();
  });

  it("lets the player walk to the end of the pier", () => {
    expect(world.get(19, GROUND_Y, 54)).toBe(Block.PLANKS);
    expect(findPath(grid, spawn, { x: 20, y: 54 })).not.toBeNull();
    expect(grid.isWalkable(20, 50)).toBe(true);
    expect(grid.isWalkable(30, 50)).toBe(false); // open sea
  });

  it("puts a reachable bed in the player's home", () => {
    const home = town.buildings.find((b) => b.id === "home")!;
    expect(home.activity?.id).toBe("sleep");
    const anchors = home.activity!.anchors;
    expect(anchors.every((a) => world.get(a.x, a.y, a.z) === Block.BED)).toBe(true);
    const beside = anchors.flatMap((a) => [[a.x, a.z + 1], [a.x + 1, a.z], [a.x - 1, a.z]] as const)
      .filter(([x, z]) => isInsideBuilding(home, x, z) && grid.isWalkable(x, z));
    expect(beside.some(([x, z]) => findPath(grid, spawn, { x, y: z }) !== null)).toBe(true);
  });

  it("gives Sam a reachable spot for every hour of the day", () => {
    const sam = town.npcs.find((n) => n.id === "sam");
    expect(sam?.voice).toBe("friend");
    const stops = sam?.schedule ?? [];
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(grid.isWalkable(stop.cell.x, stop.cell.z), `${stop.from} spot`).toBe(true);
      expect(findPath(grid, spawn, { x: stop.cell.x, y: stop.cell.z }), `${stop.from} reachable`).not.toBeNull();
    }
    const samHome = town.buildings.find((b) => b.id === "sam_home")!;
    expect(isInsideBuilding(samHome, sam!.cell.x, sam!.cell.z)).toBe(true);
  });
});

describe("meeting places", () => {
  const town = buildTown();
  const { world } = town;
  const npcCells = new Set(town.npcs.filter((n) => !n.schedule).map((n) => `${n.cell.x},${n.cell.z}`));
  const grid: PathfindingGrid = {
    width: world.width,
    height: world.depth,
    isWalkable: (x, z) => world.isStandable(x, z, GROUND_Y) && !npcCells.has(`${x},${z}`),
  };
  const spawn = { x: town.spawn.x, y: town.spawn.z };

  it("match the backend place ids and Sam can stand at each", async () => {
    const { readFileSync } = await import("node:fs");
    const candidates = ["../api/game_data/plans.json", "/api/game_data/plans.json"];
    const path = candidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } });
    if (path) {
      const ids = (JSON.parse(readFileSync(path, "utf-8")) as { places: { place_id: string }[] }).places.map((p) => p.place_id);
      expect(Object.keys(MEETING_PLACES).sort()).toEqual([...ids].sort());
    }
    for (const [id, place] of Object.entries(MEETING_PLACES).filter(([, p]) => (p.world ?? "town") === "town")) {
      expect(grid.isWalkable(place.cell.x, place.cell.z), id).toBe(true);
      expect(findPath(grid, spawn, { x: place.cell.x, y: place.cell.z }), id).not.toBeNull();
      if (place.buildingId) {
        const building = town.buildings.find((b) => b.id === place.buildingId)!;
        expect(isInsideBuilding(building, place.cell.x, place.cell.z), id).toBe(true);
      }
    }
  });
});
