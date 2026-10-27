import type { AdventureContent, AdventureState, InventoryEntry } from "../services/PraglishApiClient";
import { allQuests, clampStage, questStatus, tierView } from "./adventureProgress";
import "./adventure.css";

export class AdventureJournal {
  private readonly root: HTMLElement;
  private readonly tracker: HTMLButtonElement;
  private readonly content: HTMLElement;
  private readonly hero: HTMLElement;
  private adventure: AdventureContent | null = null;
  private stage = 0;
  private inventory: InventoryEntry[] = [];
  private loaded = false;
  private loadError: string | null = null;

  constructor(container: HTMLElement, private readonly onOpen: () => void, private readonly onClose: () => void, private readonly onInventory: () => void) {
    this.tracker = document.createElement("button");
    this.tracker.type = "button";
    this.tracker.className = "adventure-tracker";
    this.tracker.setAttribute("aria-label", "Open the active adventure quest");
    this.tracker.addEventListener("click", () => this.onOpen());
    container.appendChild(this.tracker);

    this.root = document.createElement("section");
    this.root.className = "adventure-journal";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Adventure quests");
    this.root.innerHTML = `
      <div class="adventure-board">
        <header class="adventure-board__hero">
          <img src="/assets/modes/adventure.png" alt="A block-world traveler setting out with a map" />
          <div class="adventure-board__hero-copy" data-hero></div>
          <button type="button" class="adventure-board__close" aria-label="Close quests">✕</button>
        </header>
        <div class="adventure-board__content" data-content></div>
        <footer class="adventure-board__footer"><span>Quests unlock in order · Progress is saved to your account</span><div><button type="button" data-action="inventory">🎒 INVENTORY</button><button type="button" data-action="explore">EXPLORE TOWN ↗</button></div></footer>
      </div>`;
    container.appendChild(this.root);
    const content = this.root.querySelector<HTMLElement>("[data-content]");
    if (!content) throw new Error("Adventure journal content is missing");
    this.content = content;
    const hero = this.root.querySelector<HTMLElement>("[data-hero]");
    if (!hero) throw new Error("Adventure journal hero is missing");
    this.hero = hero;
    this.root.querySelector<HTMLButtonElement>(".adventure-board__close")?.addEventListener("click", () => this.close());
    this.root.querySelector<HTMLButtonElement>("[data-action='explore']")?.addEventListener("click", () => this.close());
    this.root.querySelector<HTMLButtonElement>("[data-action='inventory']")?.addEventListener("click", () => this.onInventory());
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      event.stopPropagation();
    });
    this.render();
  }

  get isOpen(): boolean { return !this.root.hidden; }

  open(): void {
    this.root.hidden = false;
    this.tracker.hidden = true;
    this.render();
    this.root.querySelector<HTMLButtonElement>("[data-action='explore']")?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.tracker.hidden = false;
    this.onClose();
  }

  setState(state: AdventureState): void {
    if (!state.adventure?.tiers?.length) {
      // An API without adventure content (old build or bad deploy) is a load failure, not an empty chapter.
      this.setError("Could not load quests. Refresh the page and try again.");
      return;
    }
    this.adventure = state.adventure;
    this.stage = clampStage(state.stage, allQuests(state.adventure).length);
    this.inventory = state.inventory;
    this.loaded = true;
    this.loadError = null;
    this.render();
  }

  setError(message: string): void {
    this.loaded = true;
    this.loadError = message;
    this.render();
  }

  setStage(stage: number): void {
    this.stage = clampStage(stage, this.adventure ? allQuests(this.adventure).length : stage);
    this.loaded = true;
    this.loadError = null;
    this.render();
  }

  addItems(changes: InventoryEntry[]): void {
    for (const change of changes) {
      const current = this.inventory.find((item) => item.item_id === change.item_id);
      if (current) current.quantity += change.quantity;
      else this.inventory.push({ ...change });
    }
    this.inventory = this.inventory.filter((item) => item.quantity > 0);
    this.loadError = null;
    this.render();
  }

  private render(): void {
    const inventoryText = this.loadError ? this.loadError : !this.loaded ? "Loading…" : this.inventory.length ? this.inventory.map((item) => `${escapeHtml(item.name)} ×${item.quantity}`).join(" · ") : "Empty for now";
    const adventure = this.adventure;
    if (!adventure) {
      const message = this.loadError ?? "Loading quests…";
      this.tracker.innerHTML = `<span>✦ ADVENTURE QUEST</span><strong>${this.loadError ? "Quests unavailable" : "Loading quests…"}</strong><small>Open the quest journal ↗</small>`;
      this.hero.innerHTML = `<span>ADVENTURE</span><h1>Quest Journal</h1><p>${escapeHtml(message)}</p>`;
      this.content.innerHTML = `<p class="adventure-board__next" role="status">${this.loadError ? "The game server did not respond. Make sure the API is running, then refresh the page." : "Loading your quests…"}</p>`;
      return;
    }
    const view = tierView(adventure, this.stage);
    if (!view) return;
    const { chapter, quests } = view.tier;
    const local = view.stage;
    const done = view.done;
    const active = quests[local];
    this.hero.innerHTML = `<span>${escapeHtml(chapter.label)}</span><h1>${escapeHtml(chapter.title)}</h1><p>${escapeHtml(chapter.intro)}</p>`;
    this.tracker.innerHTML = `<span>✦ ADVENTURE QUEST</span><strong>${escapeHtml(done ? chapter.complete_title : active?.title ?? "Quest")}</strong><small>${done ? "Open the quest journal" : escapeHtml(active?.place ?? "")} ↗</small>`;
    this.content.innerHTML = `
      <div class="adventure-board__section"><div><span class="adventure-board__eyebrow">QUEST CHAIN</span><h2>${done ? "The Journey Begins" : "Next Step"}</h2></div><span class="adventure-board__count">${Math.min(local, quests.length)} / ${quests.length}</span></div>
      <section class="adventure-inventory" aria-label="Inventory"><strong>🎒 INVENTORY</strong><span>${escapeHtml(inventoryText)}</span></section>
      <div class="adventure-steps">${quests.map((quest, index) => {
        const status = questStatus(index, local);
        const badge = { done: "✓", active: "◆", locked: "▣" }[status];
        return `<article class="adventure-step is-${status}"><span class="adventure-step__badge">${badge}</span><div><small>QUEST ${String(index + 1).padStart(2, "0")} · ${escapeHtml(quest.place)}</small><h3>${escapeHtml(quest.title)}</h3><p>${escapeHtml(quest.detail)}</p></div><span class="adventure-step__state">${status.toUpperCase()}</span></article>`;
      }).join("")}</div>
      <p class="adventure-board__next">${done ? escapeHtml(chapter.complete_text) : "Complete the active quest to unlock the next one. Approach a character and press T to talk."}</p>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
