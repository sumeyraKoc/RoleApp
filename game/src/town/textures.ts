import { ATLAS_COLUMNS, TILE_PX, Tile } from "./blocks";
import type { CharacterLook } from "./townMap";
import { createRng, pick, type Rng } from "./rng";

/**
 * Original 16x16 block textures painted in code. No Minecraft assets are used:
 * Mojang's usage guidelines reserve its textures. To swap in hand-made or
 * Codex-generated art later, replace this atlas with a 128x128 PNG (8x8 tiles) in the same tile order.
 */

type Painter = (x: number, y: number) => string | null;

const GRASS = ["#5d9b3a", "#67a843", "#4f8a31", "#72b34b", "#5d9b3a"];
const DIRT = ["#7a5233", "#8a5f3c", "#6b4629", "#94693f"];
const BOOKS = ["#8c2f39", "#2f5d8c", "#3d7a46", "#c49a2b", "#6b3d8c", "#2a6b6b", "#a3532a"];

function planks(rng: Rng, pal: readonly string[], line: string): Painter {
  const seams = [3, 11, 7, 14];
  const grain = pal[3] ?? line;
  const base = pal.slice(0, 3);
  return (x, y) => {
    if (y % 4 === 3) return line;
    if (x === seams[Math.floor(y / 4)]) return line;
    return rng() < 0.12 ? grain : pick(rng, base);
  };
}

export function paintBlockAtlas(seed = 20261012): HTMLCanvasElement {
  const rng = createRng(seed);
  const size = ATLAS_COLUMNS * TILE_PX;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");

  const paint = (tile: number, painter: Painter) => {
    const ox = (tile % ATLAS_COLUMNS) * TILE_PX;
    const oy = Math.floor(tile / ATLAS_COLUMNS) * TILE_PX;
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        const c = painter(x, y);
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
    }
  };

  paint(Tile.grassTop, () => pick(rng, GRASS));
  paint(Tile.dirt, () => pick(rng, DIRT));
  const grassDepth = Array.from({ length: TILE_PX }, () => 3 + (rng() < 0.5 ? 1 : 0) + (rng() < 0.3 ? 1 : 0));
  paint(Tile.grassSide, (x, y) => (y < (grassDepth[x] ?? 3) ? pick(rng, GRASS) : pick(rng, DIRT)));
  paint(Tile.cobble, (x, y) => {
    if (y === 0 || y === 5 || y === 10) return "#5b5b5e";
    const seams = y < 5 ? [6, 13] : y < 10 ? [3, 10] : [7, 14];
    if (seams.includes(x)) return "#5b5b5e";
    if ((y === 1 || y === 6 || y === 11) && rng() < 0.5) return "#acacae";
    return pick(rng, ["#8d8d90", "#7f7f82", "#97979a", "#868689"]);
  });
  paint(Tile.planks, planks(rng, ["#b8874f", "#ae7f48", "#c29358", "#9c6e3d"], "#7d5a32"));
  paint(Tile.dark, planks(rng, ["#64442a", "#6e4c2f", "#5b3d25", "#4c321e"], "#3a2716"));
  const bark = Array.from({ length: TILE_PX }, () => pick(rng, ["#6b4a2b", "#5a3d22", "#7a5531"]));
  paint(Tile.logSide, (x) => (rng() < 0.18 ? "#4a321c" : bark[x] ?? "#6b4a2b"));
  paint(Tile.logTop, (x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (d > 6.5) return "#5a3d22";
    if (d < 1) return "#9a7044";
    return Math.floor(d) % 2 ? "#c49a62" : "#b0844f";
  });
  paint(Tile.brick, (x, y) => {
    if (y % 4 === 3) return "#cfc6b8";
    const offset = Math.floor(y / 4) % 2 ? 4 : 0;
    if ((x + offset) % 8 === 7) return "#cfc6b8";
    return pick(rng, ["#a5482f", "#b5543a", "#9c442c", "#ad4e34"]);
  });
  paint(Tile.glass, (x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return "#e4f2f7";
    if ((x - y === 5 && x > 6 && x < 12) || (x - y === 7 && x > 9 && x < 13)) return "rgba(255,255,255,0.95)";
    return null;
  });
  paint(Tile.leaves, () => (rng() < 0.2 ? null : pick(rng, ["#3f7d2c", "#4a8f34", "#356b25", "#5aa040"])));
  paint(Tile.plaster, () => (rng() < 0.75 ? "#ece3cf" : pick(rng, ["#e2d7bf", "#f3ebda"])));
  paint(Tile.roof, (x, y) => {
    const row = Math.floor(y / 4);
    if (y % 4 === 3) return "#7c2f1f";
    if ((x + (row % 2) * 3) % 6 === 5) return "#8e3826";
    return pick(rng, ["#b6503a", "#c25d45", "#a8452f"]);
  });
  paint(Tile.awning, (x, y) => {
    const red = Math.floor(x / 4) % 2 === 0;
    if (y >= 14) return red ? "#a8352b" : "#d6d0c4";
    return red ? "#d0473a" : "#f4efe6";
  });

  const books: Array<{ x: number; y0: number; y1: number; top: number; color: string }> = [];
  for (const [y0, y1] of [[1, 6], [9, 14]] as const) {
    let x = 1;
    while (x < 15) {
      const w = rng() < 0.5 ? 1 : 2;
      const color = pick(rng, BOOKS);
      const top = y0 + Math.floor(rng() * 3);
      for (let i = 0; i < w && x < 15; i++, x++) books.push({ x, y0, y1, top, color });
    }
  }
  paint(Tile.shelf, (x, y) => {
    if (y === 0 || y === 15 || y === 7 || y === 8) return y === 8 || y === 15 ? "#7d5a32" : "#b8874f";
    if (x === 0 || x === 15) return "#7d5a32";
    const book = books.find((b) => b.x === x && y >= b.y0 && y <= b.y1);
    if (!book) return "#3a2716";
    return y < book.top ? "#3a2716" : book.color;
  });
  // CD / cassette rack: two rows of thin, bright cases with white label dots.
  const CASES = ["#e2574c", "#3d8bd6", "#f2b134", "#52b36b", "#a65fd6", "#e07ab5", "#2fb8b0", "#f4efe6"];
  const caseCols = Array.from({ length: TILE_PX }, () => pick(rng, CASES));
  paint(Tile.cdShelf, (x, y) => {
    if (x === 0 || x === 15) return "#3a2716";
    if (y === 0 || y === 7 || y === 8 || y === 15) return y === 8 || y === 15 ? "#2a1c10" : "#5b3d25";
    const top = y < 8 ? 1 : 9;
    const c = caseCols[(x + (y < 8 ? 0 : 5)) % TILE_PX] ?? "#3d8bd6";
    if (y === top) return "#1e140c";
    if (y === top + 2 && x % 2 === 0) return "#ffffff";
    return x % 2 === 0 ? c : "#1e140c";
  });
  paint(Tile.water, (x, y) => ((x + 2 * y) % 7 === 0 && rng() < 0.6 ? "#86b6f0" : pick(rng, ["#3b74c9", "#4682d6", "#3368b8"])));
  paint(Tile.sand, () => pick(rng, ["#e8d39a", "#e2cb8d", "#eedcab", "#d9c083"]));
  // Patchwork quilt: red and cream squares with a white pillow band at the top.
  paint(Tile.quilt, (x, y) => (y < 4 ? "#f6f1e4" : ((x >> 2) + (y >> 2)) % 2 === 0 ? "#c4473a" : "#efe2c4"));
  // Misty Isles (Kademe 3): weathered stone, glowing crystal, a carved rune and mossy rock.
  paint(Tile.stone, () => pick(rng, ["#8a8f96", "#7d828a", "#969ba2", "#70757c"]));
  paint(Tile.crystal, (x, y) => {
    const facet = (x + y) % 6 === 0 || (x - y + 16) % 7 === 0;
    return facet ? "#e8fbff" : pick(rng, ["#5fd4f0", "#4cc3e6", "#7fe0f5", "#3fb2db"]);
  });
  paint(Tile.rune, (x, y) => {
    const glyph =
      (x === 7 || x === 8) && y > 2 && y < 13 ||
      (y === 4 || y === 5) && x > 3 && x < 12 ||
      Math.abs(x - y) <= 0 && x > 4 && x < 11 ||
      Math.abs(15 - x - y) <= 0 && x > 4 && x < 11;
    return glyph ? "#8ff3ff" : pick(rng, ["#4f555e", "#585e67", "#4a4f57"]);
  });
  paint(Tile.moss, () => pick(rng, ["#5b7f3d", "#4f7136", "#668b45", "#6f7f5a"]));

  return canvas;
}

/** 8x8 pixel face for the front of a character's head. */
export function paintFaceCanvas(look: CharacterLook): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2D canvas is not available");
  g.fillStyle = look.skin;
  g.fillRect(0, 0, 8, 8);
  g.fillStyle = look.hair;
  g.fillRect(0, 0, 8, 2);
  g.fillRect(0, 2, 1, 2);
  g.fillRect(7, 2, 1, 2);
  g.fillStyle = "#ffffff";
  g.fillRect(1, 4, 1, 1);
  g.fillRect(6, 4, 1, 1);
  g.fillStyle = look.eye;
  g.fillRect(2, 4, 1, 1);
  g.fillRect(5, 4, 1, 1);
  g.fillStyle = "rgba(120,50,40,0.75)";
  g.fillRect(3, 6, 2, 1);
  return canvas;
}
