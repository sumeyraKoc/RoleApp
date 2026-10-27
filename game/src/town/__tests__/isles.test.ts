import { describe, expect, it } from "vitest";
import { findPath, type PathfindingGrid } from "../../engine/PathFinder";
import { Block } from "../blocks";
import { buildIsles } from "../islesMap";
import { GROUND_Y, isInsideBuilding, MEETING_PLACES } from "../townMap";
import { canSail, worldFromUrl } from "../worlds";
import { FREE_PLAY_XP, xpMissing } from "../freePlay";

describe("Misty Isles map", () => {
  const isles = buildIsles();
  const { world } = isles;
  const grid = (): PathfindingGrid => ({
    width: world.width,
    height: world.depth,
    isWalkable: (x, z) => world.isStandable(x, z, GROUND_Y),
  });
  const spawn = { x: isles.spawn.x, y: isles.spawn.z };
  const door = (id: string) => {
    const b = isles.buildings.find((building) => building.id === id)!;
    return { x: b.door.x, y: b.door.z };
  };

  it("lands the player on the dock next to a boat home", () => {
    expect(grid().isWalkable(spawn.x, spawn.y)).toBe(true);
    expect(isles.boats[0]?.to).toBe("town");
    expect(isles.boats[0]?.anchors.length).toBeGreaterThan(4);
  });

  it("reaches the market, but the rune gate blocks the lighthouse until it opens", () => {
    expect(findPath(grid(), spawn, door("market"))).not.toBeNull();
    expect(findPath(grid(), spawn, door("lighthouse"))).toBeNull();
    const gate = isles.gates.find((g) => g.id === "mist_gate")!;
    expect(gate.blocks.every((b) => world.get(b.x, b.y, b.z) === Block.RUNE)).toBe(true);
    for (const b of gate.blocks) world.set(b.x, b.y, b.z, Block.AIR);
    expect(findPath(grid(), spawn, door("lighthouse"))).not.toBeNull();
  });

  it("reaches the Alchemy Lab over the east bridge, but the thorn gate blocks the witch's tower (Kademe 4)", () => {
    const fresh = buildIsles();
    const g = (): PathfindingGrid => ({
      width: fresh.world.width, height: fresh.world.depth,
      isWalkable: (x, z) => fresh.world.isStandable(x, z, GROUND_Y),
    });
    const doorOf = (id: string) => {
      const b = fresh.buildings.find((building) => building.id === id)!;
      return { x: b.door.x, y: b.door.z };
    };
    expect(findPath(g(), spawn, doorOf("lab"))).not.toBeNull();
    expect(findPath(g(), spawn, doorOf("tower"))).toBeNull();
    const thorn = fresh.gates.find((gate) => gate.id === "thorn_gate")!;
    expect(thorn.blocks.length).toBeGreaterThan(0);
    for (const b of thorn.blocks) fresh.world.set(b.x, b.y, b.z, Block.AIR);
    expect(findPath(g(), spawn, doorOf("tower"))).not.toBeNull();
    // The mist gate and the thorn gate are separate gates.
    const mist = fresh.gates.find((gate) => gate.id === "mist_gate")!;
    expect(mist.blocks.some((b) => thorn.blocks.some((t) => t.x === b.x && t.z === b.z))).toBe(false);
  });

  it("hides the witch until her first scene and teaches lab words in the lab", () => {
    expect(isles.npcs.find((n) => n.id === "morwen")?.appearsAfterScene).toBe("witch_curse");
    const lab = isles.props.filter((p) => p.location === "lab");
    expect(lab.map((p) => p.concept).sort()).toEqual(["cauldron", "flask", "mortar", "scales", "shelf", "table"]);
    for (const prop of lab) {
      for (const b of prop.blocks) expect(world.get(b.x, b.y, b.z), prop.id).not.toBe(Block.AIR);
    }
  });

  it("puts each keeper inside their building on a standable cell", () => {
    for (const npc of isles.npcs) {
      expect(grid().isWalkable(npc.cell.x, npc.cell.z), npc.id).toBe(true);
      if (!npc.buildingId) continue;
      const building = isles.buildings.find((b) => b.id === npc.buildingId)!;
      expect(isInsideBuilding(building, npc.cell.x, npc.cell.z), npc.id).toBe(true);
    }
    expect(isles.npcs.find((n) => n.id === "sam")?.follows).toBe(true);
  });

  it("is the same every time (seeded)", () => {
    const again = buildIsles();
    expect(again.world.data).toEqual(buildIsles().world.data);
  });

  it("has its meeting places inside the right buildings", () => {
    for (const [id, place] of Object.entries(MEETING_PLACES).filter(([, p]) => p.world === "isles")) {
      expect(grid().isWalkable(place.cell.x, place.cell.z), id).toBe(true);
      const building = isles.buildings.find((b) => b.id === place.buildingId)!;
      expect(isInsideBuilding(building, place.cell.x, place.cell.z), id).toBe(true);
    }
  });
});

describe("sailing between worlds", () => {
  it("builds the isles for the story and for free play, never for other modes", () => {
    expect(worldFromUrl("?mode=adventure&world=isles")).toBe("isles");
    expect(worldFromUrl("?mode=roleplay&world=isles")).toBe("isles");
    expect(worldFromUrl("?mode=dub&world=isles")).toBe("town");
    expect(worldFromUrl("?world=isles")).toBe("town");
  });

  it("lets free play sail anywhere but the story only where it is unlocked", () => {
    expect(canSail("isles", "roleplay", ["town"])).toBe(true);
    expect(canSail("isles", "adventure", ["town"])).toBe(false);
    expect(canSail("isles", "adventure", ["town", "isles"])).toBe(true);
    expect(canSail("isles", null, ["town", "isles"])).toBe(false);
  });
});

describe("free play XP locks", () => {
  it("opens worlds and places by XP", () => {
    expect(xpMissing(FREE_PLAY_XP.worlds.isles, 50)).toBe(FREE_PLAY_XP.worlds.isles - 50);
    expect(xpMissing(FREE_PLAY_XP.worlds.isles, null)).toBe(FREE_PLAY_XP.worlds.isles);
    expect(xpMissing(FREE_PLAY_XP.worlds.town, 0)).toBe(0);
    expect(xpMissing(FREE_PLAY_XP.places["market"], 10_000)).toBe(0);
    expect(xpMissing(undefined, 0)).toBe(0);
  });

  it("asks more XP for places on the isles than for sailing there", () => {
    const isles = buildIsles();
    for (const b of isles.buildings) {
      expect(FREE_PLAY_XP.places[b.id], b.id).toBeGreaterThan(FREE_PLAY_XP.worlds.isles);
    }
  });
});
