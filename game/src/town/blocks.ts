/**
 * Block catalogue. One block = 1 m x 1 m x 1 m. Every block maps its faces to
 * 16x16 tiles in an 8x8 texture atlas (see textures.ts).
 */

export const TILE_PX = 16;
/** Atlas is ATLAS_COLUMNS x ATLAS_COLUMNS tiles. */
export const ATLAS_COLUMNS = 8;

export const Tile = {
  grassTop: 0,
  grassSide: 1,
  dirt: 2,
  cobble: 3,
  planks: 4,
  logSide: 5,
  logTop: 6,
  brick: 7,
  glass: 8,
  leaves: 9,
  plaster: 10,
  roof: 11,
  awning: 12,
  shelf: 13,
  water: 14,
  dark: 15,
  cdShelf: 16,
  sand: 17,
  quilt: 18,
  stone: 19,
  crystal: 20,
  rune: 21,
  moss: 22,
} as const;

export const Block = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  COBBLE: 3,
  PLANKS: 4,
  LOG: 5,
  BRICK: 6,
  GLASS: 7,
  LEAVES: 8,
  PLASTER: 9,
  ROOF: 10,
  AWNING: 11,
  SHELF: 12,
  WATER: 13,
  DARK: 14,
  CD_SHELF: 15,
  SAND: 16,
  BED: 17,
  STONE: 18,
  CRYSTAL: 19,
  RUNE: 20,
  MOSS: 21,
} as const;

export type BlockId = (typeof Block)[keyof typeof Block];

export interface BlockDef {
  name: string;
  top: number;
  side: number;
  bottom: number;
  /** See-through block (glass, leaves): neighbours keep their faces. */
  transparent: boolean;
  /** Can a character stand on top of this block? */
  walkable: boolean;
}

function def(
  name: string,
  top: number,
  side: number = top,
  bottom: number = top,
  transparent = false,
  walkable = true,
): BlockDef {
  return { name, top, side, bottom, transparent, walkable };
}

const DEFS: Array<BlockDef | undefined> = [];
DEFS[Block.GRASS] = def("grass", Tile.grassTop, Tile.grassSide, Tile.dirt);
DEFS[Block.DIRT] = def("dirt", Tile.dirt);
DEFS[Block.COBBLE] = def("cobble", Tile.cobble);
DEFS[Block.PLANKS] = def("planks", Tile.planks);
DEFS[Block.LOG] = def("log", Tile.logTop, Tile.logSide, Tile.logTop);
DEFS[Block.BRICK] = def("brick", Tile.brick);
DEFS[Block.GLASS] = def("glass", Tile.glass, Tile.glass, Tile.glass, true);
DEFS[Block.LEAVES] = def("leaves", Tile.leaves, Tile.leaves, Tile.leaves, true, false);
DEFS[Block.PLASTER] = def("plaster", Tile.plaster);
DEFS[Block.ROOF] = def("roof", Tile.roof);
DEFS[Block.AWNING] = def("awning", Tile.awning);
DEFS[Block.SHELF] = def("shelf", Tile.planks, Tile.shelf, Tile.planks);
DEFS[Block.WATER] = def("water", Tile.water, Tile.water, Tile.water, false, false);
DEFS[Block.DARK] = def("dark planks", Tile.dark);
DEFS[Block.CD_SHELF] = def("cd shelf", Tile.dark, Tile.cdShelf, Tile.dark);
DEFS[Block.SAND] = def("sand", Tile.sand);
DEFS[Block.BED] = def("bed", Tile.quilt, Tile.planks, Tile.planks);
DEFS[Block.STONE] = def("stone", Tile.stone);
// Glowing blue crystal: see-through so its neighbours keep their faces.
DEFS[Block.CRYSTAL] = def("crystal", Tile.crystal, Tile.crystal, Tile.crystal, true, false);
DEFS[Block.RUNE] = def("rune stone", Tile.stone, Tile.rune, Tile.stone, false, false);
DEFS[Block.MOSS] = def("moss", Tile.moss, Tile.stone, Tile.stone);

export function getBlockDef(id: number): BlockDef | undefined {
  return DEFS[id];
}
