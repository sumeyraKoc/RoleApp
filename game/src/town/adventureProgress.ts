// Quest content lives in api/game_data/adventure.json and arrives with GET /api/adventure/state.
// The server decides when a quest completes; the client only displays progress and starts
// client-side triggers (scenes, places). adventure_stage indexes all tiers' quests end to end.
import type { AdventureContent, AdventureQuest, AdventureTier } from "../services/PraglishApiClient";

export type QuestStatus = "done" | "active" | "locked";

/** Keep a server stage inside 0..questCount (questCount means the chapter is complete). */
export function clampStage(stage: number, questCount: number): number {
  if (!Number.isInteger(stage) || stage < 0) return 0;
  return Math.min(stage, Math.max(0, questCount));
}

export function questStatus(index: number, stage: number): QuestStatus {
  if (index < stage) return "done";
  return index === stage ? "active" : "locked";
}

export function allQuests(content: AdventureContent): AdventureQuest[] {
  return content.tiers.flatMap((tier) => tier.quests);
}

export interface TierView {
  tier: AdventureTier;
  /** Progress inside this tier: quests before it are done. */
  stage: number;
  /** Every tier finished. */
  done: boolean;
}

/** The tier to show for a global stage: the active one, or the last tier once all are done. */
export function tierView(content: AdventureContent, stage: number): TierView | null {
  let start = 0;
  for (const tier of content.tiers) {
    if (stage < start + tier.quests.length) return { tier, stage: Math.max(0, stage - start), done: false };
    start += tier.quests.length;
  }
  const last = content.tiers[content.tiers.length - 1];
  return last ? { tier: last, stage: last.quests.length, done: true } : null;
}

export function currentQuest(content: AdventureContent, stage: number): AdventureQuest | null {
  return allQuests(content)[stage] ?? null;
}

/** Global stage right after the quest that plays this scene, or Infinity when no quest does. */
export function stageAfterScene(content: AdventureContent, sceneId: string): number {
  const index = allQuests(content).findIndex((q) => q.complete_when?.type === "scene" && q.complete_when.scene_id === sceneId);
  return index < 0 ? Number.POSITIVE_INFINITY : index + 1;
}
