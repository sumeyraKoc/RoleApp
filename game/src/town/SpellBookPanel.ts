import type {
  PraglishApiClient,
  SpellBookEntry,
  SpellBookStatus,
} from "../services/PraglishApiClient";

type Filter = "all" | SpellBookStatus;

/** Status label + shape so colour is never the only signal (roleApp 16.4). */
const STATUS: Record<SpellBookStatus, { label: string; mark: string; hint: string }> = {
  red: { label: "Red", mark: "●", hint: "You're struggling with this word; characters may use it again" },
  yellow: { label: "Yellow", mark: "▲", hint: "Worth practicing again" },
  new: { label: "New", mark: "○", hint: "Recently encountered" },
  green: { label: "Green", mark: "✓", hint: "You're getting the hang of it" },
};

const PLACE: Record<string, string> = {
  bakery: "Bakery",
  library: "Library",
  cafe: "Café",
};

export interface SpellBookEvents {
  onClose(): void;
}

/**
 * The Spell Book: every word the player struggled with or used, hardest first.
 * Data comes from GET /api/spellbook/{user_id}, which recomputes the struggle
 * score (roleApp section 4) from raw word events.
 */
export class SpellBookPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly status: HTMLElement;
  private readonly filterButtons: HTMLButtonElement[];
  private entries: SpellBookEntry[] = [];
  private filter: Filter = "all";

  constructor(container: HTMLElement, private readonly events: SpellBookEvents) {
    this.root = document.createElement("section");
    this.root.className = "town-book";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Spell Book");
    this.root.innerHTML = `
      <header class="town-book__head">
        <div>
          <p class="town-book__eyebrow">Spell Book</p>
          <h2 class="town-book__title">Spell Book</h2>
        </div>
        <button type="button" class="town-dialogue__close" aria-label="Close">Close <kbd>Esc</kbd></button>
      </header>
      <p class="town-book__summary" data-summary></p>
      <div class="town-book__filters" role="group" aria-label="Filter by status">
        <button type="button" data-filter="all" aria-pressed="true">All</button>
        <button type="button" data-filter="red" aria-pressed="false">● Red</button>
        <button type="button" data-filter="yellow" aria-pressed="false">▲ Yellow</button>
        <button type="button" data-filter="new" aria-pressed="false">○ New</button>
        <button type="button" data-filter="green" aria-pressed="false">✓ Green</button>
      </div>
      <ol class="town-book__list" aria-live="polite"></ol>
      <p class="town-dialogue__status" role="status"></p>`;
    container.appendChild(this.root);

    const q = <T extends Element>(selector: string): T => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`SpellBookPanel is missing ${selector}`);
      return el;
    };
    this.list = q(".town-book__list");
    this.summary = q("[data-summary]");
    this.status = q(".town-dialogue__status");
    this.filterButtons = [...this.root.querySelectorAll<HTMLButtonElement>("[data-filter]")];
    for (const btn of this.filterButtons) {
      btn.addEventListener("click", () => {
        this.filter = (btn.dataset["filter"] ?? "all") as Filter;
        for (const b of this.filterButtons) b.setAttribute("aria-pressed", String(b === btn));
        this.render();
      });
    }
    q<HTMLButtonElement>(".town-dialogue__close").addEventListener("click", () => this.close());
    this.root.addEventListener("keydown", (event) => {
      if (!this.isOpen) return;
      if (event.key === "Escape") this.close();
      event.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(api: PraglishApiClient): void {
    this.root.hidden = false;
    this.status.textContent = "Loading…";
    this.root.querySelector<HTMLButtonElement>(".town-dialogue__close")?.focus();
    void api.getSpellBook()
      .then((entries) => {
        this.entries = entries;
        this.status.textContent = "";
        this.render();
      })
      .catch((error: unknown) => {
        this.status.textContent = error instanceof Error ? error.message : "Could not load the Spell Book";
      });
  }

  close(): void {
    if (!this.isOpen) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) focused.blur();
    this.root.hidden = true;
    this.events.onClose();
  }

  private render(): void {
    const counts = { red: 0, yellow: 0, new: 0, green: 0 };
    for (const e of this.entries) counts[e.status]++;
    this.summary.textContent = this.entries.length
      ? `${this.entries.length} words · ${counts.red} red · ${counts.yellow} yellow · ${counts.green} green`
      : "";

    const shown = this.filter === "all" ? this.entries : this.entries.filter((e) => e.status === this.filter);
    this.list.replaceChildren();
    if (shown.length === 0) {
      const empty = document.createElement("li");
      empty.className = "town-book__empty";
      empty.textContent = this.entries.length
        ? "No words have this status yet."
        : "No words yet. Speak English with characters or examine objects in buildings. Words you practice will appear here.";
      this.list.append(empty);
      return;
    }
    for (const entry of shown) this.list.append(this.renderEntry(entry));
  }

  private renderEntry(e: SpellBookEntry): HTMLElement {
    const meta = STATUS[e.status];
    const li = document.createElement("li");
    li.className = `town-book__word is-${e.status}`;

    const head = document.createElement("div");
    head.className = "town-book__word-head";
    const word = document.createElement("strong");
    word.textContent = e.lemma;
    const chip = document.createElement("span");
    chip.className = "town-book__chip";
    chip.textContent = `${meta.mark} ${meta.label}`;
    chip.title = meta.hint;
    head.append(word, chip);

    const bar = document.createElement("div");
    bar.className = "town-book__bar";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(e.struggle_score));
    bar.setAttribute("aria-label", `Difficulty ${Math.round(e.struggle_score)}/100`);
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(2, Math.min(100, e.struggle_score))}%`;
    bar.append(fill);

    const facts = document.createElement("p");
    facts.className = "town-book__facts";
    const fails = e.meaning_fails + e.usage_fails + e.pronunciation_fails;
    const places = e.sources.map((s) => PLACE[s] ?? s).join(", ");
    facts.textContent = [
      `difficulty ${Math.round(e.struggle_score)}`,
      fails ? `${fails} struggles` : null,
      e.active_successes ? `${e.active_successes} correct uses` : null,
      places || null,
    ].filter(Boolean).join(" · ");

    li.append(head, bar, facts);
    if (e.example) {
      const example = document.createElement("q");
      example.className = "town-book__example";
      example.textContent = e.example;
      li.append(example);
    }
    return li;
  }
}
