import { Block } from "./blocks";
import { createRng, type Rng } from "./rng";
import {
  blockRange,
  GROUND_Y,
  placeBuilding,
  placeTree,
  type BlockPos,
  type BuildingSpec,
  type Cell,
  type NpcSpec,
  type TownDefinition,
} from "./townMap";
import { VoxelWorld } from "./VoxelWorld";

/**
 * Kademe 3 and 4 — the Misty Isles. Generated in code (no external assets):
 * islands shaped by value noise, a harbour with the Mist Market, a bridge with
 * a rune gate, and the old lighthouse (Kademe 3); to the east the alchemist's
 * isle with the Alchemy Lab, and the dark Thornwood with the witch's tower behind
 * a second rune gate (Kademe 4). Walkable ground stays at y = 1 like the town;
 * cliffs, rocks and crystals rise above it as scenery.
 */
export const ISLES_SIZE = { width: 96, height: 18, depth: 64 } as const;

/** Smooth value noise in [0, 1) on a lattice of `cell` blocks. */
function valueNoise(rng: Rng, width: number, depth: number, cell: number): (x: number, z: number) => number {
  const gw = Math.ceil(width / cell) + 2;
  const gd = Math.ceil(depth / cell) + 2;
  const grid = Array.from({ length: gw * gd }, () => rng());
  const at = (gx: number, gz: number) => grid[gz * gw + gx] ?? 0;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, z) => {
    const fx = x / cell;
    const fz = z / cell;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = smooth(fx - x0);
    const tz = smooth(fz - z0);
    const top = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * tx;
    const bottom = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * tx;
    return top + (bottom - top) * tz;
  };
}

interface Isle {
  cx: number;
  cz: number;
  r: number;
}

const ISLES: readonly Isle[] = [
  { cx: 30, cz: 46, r: 14 }, // harbour isle: dock, Mist Market
  { cx: 44, cz: 15, r: 10 }, // lighthouse isle
  { cx: 13, cz: 19, r: 7 }, // crystal isle (scenery)
  { cx: 66, cz: 46, r: 11 }, // alchemist's isle: Alchemy Lab (Kademe 4)
  { cx: 80, cz: 16, r: 13 }, // the Thornwood: the witch's tower (Kademe 4)
];
const THORNWOOD = { cx: 80, cz: 16, r: 15 } as const;
export const inThornwood = (x: number, z: number) => Math.hypot(x - THORNWOOD.cx, z - THORNWOOD.cz) < THORNWOOD.r;

/** Walkable route from the dock to the lighthouse door; the bridge crosses open water. */
const ROUTE: readonly Cell[] = [
  { x: 30, z: 57 }, { x: 30, z: 48 }, { x: 24, z: 48 }, { x: 24, z: 43 },
  { x: 24, z: 48 }, { x: 33, z: 41 }, { x: 37, z: 33 }, { x: 41, z: 26 }, { x: 44, z: 22 }, { x: 44, z: 20 },
];
/** Kademe 4: from the harbour road east over a bridge to the Alchemy Lab door. */
const LAB_ROUTE: readonly Cell[] = [
  { x: 31, z: 48 }, { x: 46, z: 48 }, { x: 60, z: 48 }, { x: 69, z: 48 }, { x: 65, z: 48 }, { x: 65, z: 47 },
];
/** Kademe 4: past the lab, north over the strait (thorn gate) to the witch's tower door. */
const TOWER_ROUTE: readonly Cell[] = [
  { x: 69, z: 48 }, { x: 72, z: 44 }, { x: 72, z: 26 }, { x: 78, z: 21 }, { x: 80, z: 19 }, { x: 80, z: 18 },
];
/** Open water between the southern and northern isles (bridges are the only way across). */
const STRAIT = { z0: 26, z1: 33 } as const;
/** Open water between the harbour isle and the alchemist's isle, and between the lighthouse and the Thornwood. */
const EAST_CHANNEL = { x0: 47, x1: 52, fromZ: 34 } as const;
const NORTH_CHANNEL = { x0: 56, x1: 64, toZ: 25 } as const;
const GATE_Z = 30;

function line(a: Cell, b: Cell): Cell[] {
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z), 1);
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: Math.round(a.x + ((b.x - a.x) * i) / steps),
    z: Math.round(a.z + ((b.z - a.z) * i) / steps),
  }));
}

/** The witch's tower: dark stone with glowing rune windows and a pointed roof. */
function placeTower(world: VoxelWorld): BuildingSpec {
  const x0 = 77;
  const z0 = 11;
  const x1 = 83;
  const z1 = 17;
  world.fill(x0, GROUND_Y, z0, x1, GROUND_Y, z1, Block.DARK);
  for (let y = 2; y <= 11; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (!edge) continue;
        const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
        world.set(x, y, z, corner ? Block.DARK : y % 4 === 0 ? Block.DARK : Block.STONE);
      }
    }
  }
  for (const [x, z] of [[x0, 14], [x1, 14], [80, z0]] as const) {
    world.set(x, 4, z, Block.RUNE);
    world.set(x, 8, z, Block.RUNE);
  }
  // Pointed roof.
  for (let k = 0; k <= 3; k++) world.fill(x0 - 1 + k, 12 + k, z0 - 1 + k, x1 + 1 - k, 12 + k, z1 + 1 - k, Block.DARK);
  world.set(80, 2, z1, Block.AIR);
  world.set(80, 3, z1, Block.AIR);
  world.fill(78, 2, 12, 79, 2, 12, Block.SHELF); // spell books
  world.set(82, 2, 12, Block.DARK); // her cauldron
  world.set(82, 3, 12, Block.CRYSTAL);
  return { id: "tower", name: "Witch's Tower", x0, z0, x1, z1, door: { x: 80, z: z1 }, cutY: 3, roof: { block: Block.DARK, y: 12, pitch: 1.1 } };
}

/** The old lighthouse: a striped tower with a crystal beacon on top. */
function placeLighthouse(world: VoxelWorld): BuildingSpec {
  const x0 = 41;
  const z0 = 13;
  const x1 = 47;
  const z1 = 19;
  world.fill(x0, GROUND_Y, z0, x1, GROUND_Y, z1, Block.PLANKS);
  for (let y = 2; y <= 12; y++) {
    const band = Math.floor((y - 2) / 2) % 2 === 0 ? Block.PLASTER : Block.BRICK;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
        if (edge && !corner) world.set(x, y, z, band);
        if (corner && y <= 11) world.set(x, y, z, Block.STONE);
      }
    }
  }
  for (const [x, z] of [[44, z1], [x0, 16], [x1, 16]] as const) {
    world.set(x, 3, z, Block.GLASS);
    world.set(x, 7, z, Block.GLASS);
    world.set(x, 10, z, Block.GLASS);
  }
  world.fill(x0, 13, z0, x1, 13, z1, Block.DARK); // gallery floor
  world.fill(43, 14, 15, 45, 15, 17, Block.GLASS); // lantern room
  world.fill(44, 14, 16, 44, 15, 16, Block.STONE); // the cold lamp (lit in the final scene)
  world.fill(43, 16, 15, 45, 16, 17, Block.ROOF);
  world.set(44, 2, z1, Block.AIR);
  world.set(44, 3, z1, Block.AIR);
  world.fill(42, 2, 14, 43, 2, 14, Block.SHELF); // star charts
  world.set(46, 2, 14, Block.CRYSTAL);
  return { id: "lighthouse", name: "Lighthouse", x0, z0, x1, z1, door: { x: 44, z: z1 }, cutY: 3 };
}

export function buildIsles(seed = 20261030): TownDefinition {
  const rng = createRng(seed);
  const { width, height, depth } = ISLES_SIZE;
  const world = new VoxelWorld(width, height, depth);
  const coast = valueNoise(rng, width, depth, 6);
  const detail = valueNoise(rng, width, depth, 3);
  const rocks = valueNoise(rng, width, depth, 4);

  // Sea floor and sea.
  world.fill(0, 0, 0, width - 1, 0, depth - 1, Block.SAND);
  world.fill(0, GROUND_Y, 0, width - 1, GROUND_Y, depth - 1, Block.WATER);

  // Islands: a radial falloff per isle, roughened by noise.
  const landness = (x: number, z: number) => {
    let best = -1;
    for (const isle of ISLES) {
      const d = Math.hypot(x - isle.cx, z - isle.cz) / isle.r;
      best = Math.max(best, 1 - d + (coast(x, z) - 0.5) * 0.55 + (detail(x, z) - 0.5) * 0.2);
    }
    return best;
  };
  const channel = (x: number, z: number) =>
    (z >= STRAIT.z0 && z <= STRAIT.z1) ||
    (x >= EAST_CHANNEL.x0 && x <= EAST_CHANNEL.x1 && z >= EAST_CHANNEL.fromZ) ||
    (x >= NORTH_CHANNEL.x0 && x <= NORTH_CHANNEL.x1 && z <= NORTH_CHANNEL.toZ);
  const land = (x: number, z: number) => landness(x, z) > 0 && !channel(x, z);
  for (let z = 1; z < depth - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      if (!land(x, z)) continue;
      const shore = landness(x, z) < 0.18;
      // The Thornwood is dark: moss and black earth instead of grass.
      const ground = inThornwood(x, z) ? (detail(x, z) > 0.55 ? Block.DARK : Block.MOSS) : Block.GRASS;
      world.set(x, GROUND_Y, z, shore ? Block.SAND : ground);
    }
  }

  // The walkable routes: cobble on land, a plank bridge over water. Two blocks wide.
  const routeCells = new Set<string>();
  const bridgeCells = new Set<string>();
  const paveRoute = (route: readonly Cell[]): Set<string> => {
    const cells = new Set<string>();
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      if (!a || !b) continue;
      for (const c of line(a, b)) {
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const x = c.x + dx;
          const z = c.z + dz;
          const key = `${x},${z}`;
          cells.add(key);
          if (routeCells.has(key)) continue;
          routeCells.add(key);
          const onLand = world.get(x, GROUND_Y, z) !== Block.WATER;
          if (!onLand) bridgeCells.add(key);
          world.set(x, GROUND_Y, z, onLand ? Block.COBBLE : Block.PLANKS);
          world.fill(x, 2, z, x, 4, z, Block.AIR);
        }
      }
    }
    return cells;
  };
  const mainRoute = paveRoute(ROUTE);
  paveRoute(LAB_ROUTE);
  const towerRoute = paveRoute(TOWER_ROUTE);
  // Bridge rails wherever a route crosses open water.
  for (const key of bridgeCells) {
    const [x, z] = key.split(",").map(Number) as [number, number];
    const alongX = bridgeCells.has(`${x + 1},${z}`) || bridgeCells.has(`${x - 1},${z}`);
    const sides = alongX && !(z >= STRAIT.z0 && z <= STRAIT.z1) ? [[0, 1], [0, -1]] as const : [[1, 0], [-1, 0]] as const;
    for (const [dx, dz] of sides) {
      const nx = x + dx;
      const nz = z + dz;
      if (!routeCells.has(`${nx},${nz}`) && world.get(nx, GROUND_Y, nz) === Block.WATER) world.set(nx, GROUND_Y, nz, Block.LOG);
    }
  }

  // Dock and boat on the south shore (arrival from town).
  world.fill(30, GROUND_Y, 55, 31, GROUND_Y, 62, Block.PLANKS);
  for (const z of [57, 60]) {
    world.set(29, GROUND_Y, z, Block.LOG);
    world.set(32, GROUND_Y, z, Block.LOG);
  }
  world.fill(33, GROUND_Y, 59, 35, GROUND_Y, 62, Block.PLANKS);
  world.fill(33, 2, 59, 35, 2, 59, Block.LOG);
  world.fill(33, 2, 62, 35, 2, 62, Block.LOG);
  world.fill(35, 2, 60, 35, 2, 61, Block.LOG);
  const boatAnchors: BlockPos[] = blockRange(33, 2, 59, 35, 2, 62).filter((b) => world.get(b.x, b.y, b.z) === Block.LOG);

  const buildings: BuildingSpec[] = [];
  // The Mist Market: a hall of stalls lit by crystals.
  buildings.push(placeBuilding(world, {
    id: "market", name: "Mist Market",
    x0: 19, z0: 36, w: 11, d: 7,
    wall: Block.PLANKS, roof: Block.AWNING, floor: Block.DARK,
    door: { x: 24, z: 42 },
    windows: [{ x: 21, z: 42 }, { x: 27, z: 42 }, { x: 19, z: 39 }, { x: 29, z: 39 }],
  }));
  world.fill(20, 2, 37, 22, 2, 37, Block.SHELF);
  world.fill(26, 2, 37, 28, 2, 37, Block.SHELF);
  world.set(21, 3, 37, Block.CRYSTAL);
  world.set(27, 3, 37, Block.CRYSTAL);
  world.fill(23, 2, 38, 25, 2, 38, Block.DARK); // Tobias's counter
  buildings.push(placeLighthouse(world));

  // Kademe 4: the Alchemy Lab — shelves of flasks, a bubbling cauldron, a work table with scales.
  buildings.push(placeBuilding(world, {
    id: "lab", name: "Alchemy Lab",
    x0: 61, z0: 40, w: 9, d: 7,
    wall: Block.STONE, roof: Block.DARK, floor: Block.PLANKS,
    door: { x: 65, z: 46 },
    windows: [{ x: 63, z: 46 }, { x: 67, z: 46 }, { x: 61, z: 43 }, { x: 69, z: 43 }],
  }));
  world.fill(62, 2, 41, 64, 3, 41, Block.SHELF); // books and jars
  world.fill(66, 2, 41, 68, 2, 41, Block.SHELF);
  world.fill(66, 3, 41, 68, 3, 41, Block.GLASS); // flasks
  world.set(67, 2, 43, Block.DARK); // cauldron
  world.set(67, 3, 43, Block.CRYSTAL);
  world.fill(62, 2, 44, 63, 2, 44, Block.PLANKS); // work table
  world.set(63, 3, 44, Block.STONE); // brass scales
  world.set(62, 3, 44, Block.STONE); // mortar
  buildings.push(placeTower(world));

  // Rune gates across the bridges: a spell opens each one (TownGame removes these blocks).
  const placeGate = (cells: Set<string>): BlockPos[] => {
    const blocks: BlockPos[] = [];
    for (const key of cells) {
      const [x, z] = key.split(",").map(Number) as [number, number];
      if (z !== GATE_Z) continue;
      for (let y = 2; y <= 4; y++) blocks.push({ x, y, z });
    }
    const xs = blocks.map((b) => b.x);
    for (const x of [Math.min(...xs) - 1, Math.max(...xs) + 1]) {
      world.set(x, GROUND_Y, GATE_Z, Block.STONE);
      world.fill(x, 2, GATE_Z, x, 5, GATE_Z, Block.STONE);
      world.set(x, 6, GATE_Z, Block.CRYSTAL);
    }
    for (const b of blocks) world.set(b.x, b.y, b.z, Block.RUNE);
    return blocks;
  };
  const gateBlocks = placeGate(mainRoute);
  const thornGateBlocks = placeGate(towerRoute);

  // Scenery: rock spires, crystal clusters and a few trees, kept off the route and buildings.
  const clear = (x: number, z: number) => {
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (routeCells.has(`${x + dx},${z + dz}`)) return false;
    return !buildings.some((b) => x >= b.x0 - 2 && x <= b.x1 + 2 && z >= b.z0 - 2 && z <= b.z1 + 2) &&
      !(x >= 27 && x <= 37 && z >= 53);
  };
  for (let z = 2; z < depth - 2; z++) {
    for (let x = 2; x < width - 2; x++) {
      if (world.get(x, GROUND_Y, z) !== Block.GRASS || !clear(x, z)) continue;
      const r = rocks(x, z);
      if (r > 0.78) {
        const h = 2 + Math.floor((r - 0.78) * 30);
        world.fill(x, 2, z, x, Math.min(height - 3, 2 + h), z, Block.STONE);
        world.set(x, GROUND_Y, z, Block.MOSS);
        if (rng() < 0.4) world.set(x, Math.min(height - 2, 3 + h), z, Block.CRYSTAL);
      } else if (r < 0.12 && rng() < 0.5) {
        world.set(x, 2, z, Block.CRYSTAL);
        if (rng() < 0.5) world.set(x, 3, z, Block.CRYSTAL);
      } else if (inThornwood(x, z)) {
        // Bare, twisted trees in the Thornwood.
        if (rng() < 0.03) {
          world.fill(x, 2, z, x, 4, z, Block.LOG);
          world.set(x + (rng() < 0.5 ? 1 : -1), 4, z, Block.LOG);
          world.set(x, 5, z + (rng() < 0.5 ? 1 : -1), Block.LOG);
        }
      } else if (rng() < 0.012) {
        placeTree(world, x, z, rng);
      }
    }
  }

  const npcs: NpcSpec[] = [
    {
      id: "elowen", name: "Elowen", title: "Lighthouse Keeper", location: "lighthouse", npcRole: "keeper", voice: "keeper",
      buildingId: "lighthouse", cell: { x: 44, z: 16 },
      greeting: "Ah, travellers. The mist hasn't let a boat through in years…",
      look: { shirt: "#3e5a7a", pants: "#2b2f3a", skin: "#e8c3a0", hair: "#d9d9d9", eye: "#3b6a8a", hat: "#2f3f5a" },
    },
    {
      id: "tobias", name: "Tobias", title: "Merchant", location: "market", npcRole: "merchant", voice: "merchant",
      buildingId: "market", cell: { x: 24, z: 39 },
      greeting: "Lanterns, charms, maps! Everything has a price, friend.",
      look: { shirt: "#7a3e5a", pants: "#3a2a20", skin: "#b07a52", hair: "#2a1a10", eye: "#2a1a10", apron: true },
    },
    {
      // Kademe 4: the alchemist who takes the player on as his lab assistant.
      id: "orrin", name: "Orrin", title: "Alchemist", location: "lab", npcRole: "alchemist", voice: "alchemist",
      buildingId: "lab", cell: { x: 65, z: 43 },
      greeting: "Careful! That flask is older than you are.",
      look: { shirt: "#5b3f8c", pants: "#2e2440", skin: "#e3b48f", hair: "#ececec", eye: "#2a2a3a", apron: true },
    },
    {
      // Kademe 4: the Thornwood witch. She first appears in the "witch_curse" cutscene.
      id: "morwen", name: "Morwen", title: "Thornwood Witch", location: "tower", npcRole: "witch", voice: "witch",
      buildingId: "tower", cell: { x: 80, z: 14 },
      greeting: "Who dares climb my stairs?",
      look: { shirt: "#2b1f3a", pants: "#1a1424", skin: "#d6c6b6", hair: "#151515", eye: "#7a3cff", hat: "#1e1630", hatShape: "pointy" },
      appearsAfterScene: "witch_curse",
    },
    {
      // Sam travels with the player on the isles (same NPC as in town: location town / friend).
      id: "sam", name: "Sam", title: "Friend", location: "town", npcRole: "friend", voice: "friend",
      buildingId: "", cell: { x: 31, z: 57 }, follows: true,
      greeting: "This place is wild! Take a photo with me!",
      look: { shirt: "#e0a43a", pants: "#3b4a6b", skin: "#c98e63", hair: "#3a2414", eye: "#2b1d12" },
    },
  ];

  return {
    id: "isles",
    world,
    buildings,
    npcs,
    props: [
      { id: "lab-shelf", buildingId: "lab", location: "lab", concept: "shelf", blocks: blockRange(62, 2, 41, 64, 3, 41) },
      { id: "lab-flask", buildingId: "lab", location: "lab", concept: "flask", blocks: blockRange(66, 3, 41, 68, 3, 41) },
      { id: "lab-cauldron", buildingId: "lab", location: "lab", concept: "cauldron", blocks: blockRange(67, 2, 43, 67, 3, 43) },
      { id: "lab-scales", buildingId: "lab", location: "lab", concept: "scales", blocks: [{ x: 63, y: 3, z: 44 }] },
      { id: "lab-mortar", buildingId: "lab", location: "lab", concept: "mortar", blocks: [{ x: 62, y: 3, z: 44 }] },
      { id: "lab-table", buildingId: "lab", location: "lab", concept: "table", blocks: blockRange(62, 2, 44, 63, 2, 44) },
    ],
    spawn: { x: 30, z: 58 },
    boats: [{ to: "town", label: "Sail back to town", anchors: boatAnchors }],
    gates: [
      { id: "mist_gate", label: "Rune gate", blocks: gateBlocks },
      { id: "thorn_gate", label: "Thorn gate", blocks: thornGateBlocks },
    ],
    atmosphere: { fog: "#c9d6e2", fogNear: 95, fogFar: 150 },
  };
}
