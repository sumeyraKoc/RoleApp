import type { PraglishApiClient, SpellCastResult, SpellInfo } from "../services/PraglishApiClient";
import "./spell.css";

export interface SpellEvents {
  onClose(): void;
  /** The gate accepted the spell. */
  onOpened(result: SpellCastResult): void;
}

/**
 * Kademe 3: casting a spell at a rune gate. The spell is an English word
 * (often one from the player's own Spell Book); a natural sentence that uses
 * it correctly opens the gate.
 */
export class SpellPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly word: HTMLElement;
  private readonly source: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly cast: HTMLButtonElement;
  private gateId = "";
  private busy = false;

  constructor(
    container: HTMLElement,
    private readonly api: PraglishApiClient,
    private readonly events: SpellEvents,
    /** Free play: casts are practice and don't change the story. */
    private readonly practice = false,
  ) {
    this.root = document.createElement("section");
    this.root.className = "spell-panel";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Cast a spell");
    this.root.innerHTML = `
      <button type="button" class="spell-panel__close" aria-label="Close">✕</button>
      <p class="spell-panel__eyebrow" data-title>RUNE GATE</p>
      <p class="spell-panel__lead">The runes wait for one word, used well:</p>
      <p class="spell-panel__word" data-word>…</p>
      <p class="spell-panel__source" data-source></p>
      <form class="spell-panel__form">
        <input type="text" maxlength="300" autocomplete="off" placeholder="Say a full English sentence with this word…" aria-label="Your spell" />
        <button type="submit">Cast ✨</button>
      </form>
      <p class="spell-panel__feedback" role="status" data-feedback></p>`;
    container.appendChild(this.root);
    const q = <T extends Element>(selector: string): T => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`SpellPanel is missing ${selector}`);
      return el;
    };
    this.title = q("[data-title]");
    this.word = q("[data-word]");
    this.source = q("[data-source]");
    this.feedback = q("[data-feedback]");
    this.input = q("input");
    this.cast = q(".spell-panel__form button");
    q<HTMLButtonElement>(".spell-panel__close").addEventListener("click", () => this.close());
    q<HTMLFormElement>(".spell-panel__form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      event.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(gateId: string): Promise<void> {
    this.gateId = gateId;
    this.root.hidden = false;
    this.word.textContent = "…";
    this.source.textContent = "";
    this.feedback.textContent = "";
    this.feedback.className = "spell-panel__feedback";
    this.input.value = "";
    try {
      this.show(await this.api.getSpell(gateId));
    } catch (error: unknown) {
      this.feedback.textContent = error instanceof Error ? error.message : "The runes are silent.";
    }
    this.input.focus();
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.events.onClose();
  }

  private show(spell: SpellInfo): void {
    this.title.textContent = spell.gate_name.toUpperCase();
    this.word.textContent = spell.word.toUpperCase();
    this.source.textContent = spell.source === "spellbook"
      ? "📖 From your Spell Book — a word you have found hard. Make it yours!"
      : "A word of the isles.";
    if (spell.opened) this.feedback.textContent = "This gate is already open.";
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.cast.disabled = true;
    this.feedback.className = "spell-panel__feedback";
    this.feedback.textContent = "The runes listen…";
    try {
      const result = await this.api.castSpell(this.gateId, text, this.practice);
      if (result.success) {
        this.feedback.className = "spell-panel__feedback is-good";
        this.feedback.textContent = "✨ The runes blaze with light!";
        this.events.onOpened(result);
        window.setTimeout(() => this.close(), 900);
      } else {
        this.feedback.className = "spell-panel__feedback is-hint";
        this.feedback.textContent = result.correction && result.correction !== text
          ? `${result.hint ?? ""} Try: "${result.correction}"`
          : result.hint ?? "The runes stay dark.";
      }
    } catch (error: unknown) {
      this.feedback.className = "spell-panel__feedback is-hint";
      this.feedback.textContent = error instanceof Error ? error.message : "The magic is busy. Try again.";
    } finally {
      this.busy = false;
      this.cast.disabled = false;
      this.input.focus();
    }
  }
}
