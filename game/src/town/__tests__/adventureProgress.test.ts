import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdventureContent } from "../../services/PraglishApiClient";
import { clampStage, currentQuest, questStatus, stageAfterScene, tierView } from "../adventureProgress";

const chapter = { id: "c", label: "L", title: "T", intro: "I", complete_title: "CT", complete_text: "CX" };
const quest = (id: string, extra: object = {}) => ({ id, title: id, place: "p", detail: "d", ...extra });
const content: AdventureContent = {
  tiers: [
    { tier: 1, cefr: "A1", chapter, quests: [quest("a"), quest("b"), quest("c")] },
    { tier: 2, cefr: "A2", chapter: { ...chapter, id: "c2" }, quests: [
      quest("scene", { complete_when: { type: "scene", scene_id: "meet_sam" } }), quest("e"),
    ] },
  ],
};

describe("adventure quest progression", () => {
  it("keeps the server stage within the chapter", () => {
    expect(clampStage(-1, 3)).toBe(0);
    expect(clampStage(Number.NaN, 3)).toBe(0);
    expect(clampStage(2, 3)).toBe(2);
    expect(clampStage(7, 3)).toBe(3);
  });

  it("marks earlier quests done, the current one active, later ones locked", () => {
    expect([0, 1, 2].map((index) => questStatus(index, 1))).toEqual(["done", "active", "locked"]);
  });

  it("maps a global stage onto its tier", () => {
    expect(tierView(content, 1)).toMatchObject({ tier: { tier: 1 }, stage: 1, done: false });
    expect(tierView(content, 3)).toMatchObject({ tier: { tier: 2 }, stage: 0, done: false });
    expect(tierView(content, 5)).toMatchObject({ tier: { tier: 2 }, stage: 2, done: true });
    expect(currentQuest(content, 3)?.id).toBe("scene");
    expect(stageAfterScene(content, "meet_sam")).toBe(4);
    expect(stageAfterScene(content, "nope")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("adventure content file", () => {
  const candidates = ["../api/game_data/adventure.json", "/api/game_data/adventure.json"];
  const path = candidates.find((candidate) => {
    try { readFileSync(candidate); return true; } catch { return false; }
  });

  it.skipIf(!path)("has the display fields the journal renders", () => {
    const file = JSON.parse(readFileSync(path as string, "utf-8")) as AdventureContent;
    expect(file.tiers.length).toBeGreaterThan(1);
    for (const tier of file.tiers) {
      expect(tier.chapter.title).toBeTruthy();
      for (const q of tier.quests) expect(q.id && q.title && q.place && q.detail).toBeTruthy();
    }
  });
});
