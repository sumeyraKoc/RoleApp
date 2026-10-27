import { buildIsles } from "./islesMap";
import { buildTown, type TownDefinition, type WorldId } from "./townMap";

export const WORLD_NAMES: Record<WorldId, string> = { town: "Town", isles: "Misty Isles" };

/** Modes that can sail to the isles: the story (adventure) and free play (roleplay). */
const ISLES_MODES = new Set(["adventure", "roleplay"]);

/** The world to build for a page load. */
export function worldFromUrl(search: string): WorldId {
  const params = new URLSearchParams(search);
  return ISLES_MODES.has(params.get("mode") ?? "") && params.get("world") === "isles" ? "isles" : "town";
}

/** Free play sails anywhere; the story only to worlds it has unlocked. */
export function canSail(to: WorldId, mode: string | null, unlocked: readonly string[]): boolean {
  if (mode === "roleplay") return true;
  return mode === "adventure" && unlocked.includes(to);
}

export function buildWorld(id: WorldId): TownDefinition {
  return id === "isles" ? buildIsles() : buildTown();
}

/** The page URL for a world, keeping the current mode. */
export function worldUrl(id: WorldId, search: string): string {
  const params = new URLSearchParams(search);
  if (id === "town") params.delete("world");
  else params.set("world", id);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}
