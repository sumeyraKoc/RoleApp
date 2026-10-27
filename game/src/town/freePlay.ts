import type { WorldId } from "./townMap";

/**
 * Free play (roleplay mode) unlocks by XP instead of by the story:
 * a world needs some XP to sail to, and some places in it need more to enter.
 * The story (adventure mode) ignores these; its quests decide what is open.
 */
export const FREE_PLAY_XP = {
  worlds: { town: 0, isles: 200 } as Record<WorldId, number>,
  places: { market: 300, lighthouse: 450, lab: 600, tower: 800 } as Record<string, number>,
};

/** XP still missing for a requirement (0 when unlocked). Unknown XP counts as 0. */
export function xpMissing(required: number | undefined, xp: number | null): number {
  if (!required) return 0;
  return Math.max(0, required - (xp ?? 0));
}
