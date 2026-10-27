import type { AdventureFlags, Cutscene, CutsceneStep, CutsceneTarget, TurnResponse } from "../services/PraglishApiClient";
import type { Cell } from "./townMap";
import "./cutscene.css";

/** What a cutscene needs from the town: actors, camera, voices. */
export interface CutsceneStage {
  flags: AdventureFlags;
  actorName(who: string): string;
  placeActor(who: string, cell: Cell): void;
  /** Resolves when the actor arrives (or gives up and snaps there). */
  walkActor(who: string, to: Cell, run: boolean): Promise<void>;
  /** A free cell next to another actor, for "walk near". */
  cellNear(who: string): Cell | null;
  focus(target: CutsceneTarget, zoom?: number): void;
  /** Speak a line aloud; resolves when the audio ends or fails. */
  speak(who: string, text: string): Promise<void>;
  toast(text: string): void;
  /** Send the player's line to the NPC through the normal turn pipeline, with the scene moment as context. */
  converse(who: string, text: string, sceneNote: string): Promise<TurnResponse>;
  /** A world effect named by the scene (e.g. "light_beacon"). */
  trigger(name: string): void;
}

/** Wrong answers before the player may move on without a correct one. */
const ASK_ATTEMPTS_BEFORE_CONTINUE = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Plays api/game_data/cutscenes/<id>.json in the town: letterbox bars, scripted
 * camera, characters walking and talking with voice + subtitles. Space, Enter or
 * a click moves to the next line; Esc skips the rest.
 */
export class CutscenePlayer {
  private readonly root: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly speaker: HTMLElement;
  private readonly line: HTMLElement;
  private readonly card: HTMLElement;
  private readonly veil: HTMLElement;
  private readonly askForm: HTMLFormElement;
  private readonly askGoal: HTMLElement;
  private readonly askFeedback: HTMLElement;
  private readonly askInput: HTMLInputElement;
  private readonly askSend: HTMLButtonElement;
  private readonly askHint: HTMLButtonElement;
  private readonly askContinue: HTMLButtonElement;
  private advance: (() => void) | null = null;
  private skipped = false;
  private playing = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "cutscene";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="cutscene__bar cutscene__bar--top"></div>
      <div class="cutscene__bar cutscene__bar--bottom"></div>
      <div class="cutscene__veil"></div>
      <p class="cutscene__card" hidden></p>
      <div class="cutscene__subtitle" hidden><strong></strong><span></span><small>Space ▸</small></div>
      <form class="cutscene__ask" hidden>
        <p class="cutscene__goal">🎯 <span data-goal></span></p>
        <p class="cutscene__feedback" data-feedback></p>
        <div class="cutscene__ask-row">
          <input type="text" maxlength="240" autocomplete="off" placeholder="Answer in English…" aria-label="Your answer" />
          <button type="submit">Say it</button>
        </div>
        <div class="cutscene__ask-tools">
          <button type="button" data-hint>Need an idea?</button>
          <button type="button" data-continue hidden>Continue ▸</button>
        </div>
      </form>
      <button type="button" class="cutscene__skip">Skip <kbd>Esc</kbd></button>`;
    container.appendChild(this.root);
    const q = <T extends Element>(selector: string): T => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`Cutscene is missing ${selector}`);
      return el;
    };
    this.subtitle = q(".cutscene__subtitle");
    this.speaker = q(".cutscene__subtitle strong");
    this.line = q(".cutscene__subtitle span");
    this.card = q(".cutscene__card");
    this.veil = q(".cutscene__veil");
    this.askForm = q(".cutscene__ask");
    this.askGoal = q("[data-goal]");
    this.askFeedback = q("[data-feedback]");
    this.askInput = q(".cutscene__ask input");
    this.askSend = q(".cutscene__ask button[type='submit']");
    this.askHint = q("[data-hint]");
    this.askContinue = q("[data-continue]");
    q<HTMLButtonElement>(".cutscene__skip").addEventListener("click", () => this.skip());
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      // A question waits for an answer: tapping around it (e.g. to hide the phone keyboard) must not skip it.
      if (!this.askForm.hidden) return;
      if (!target.closest(".cutscene__skip") && !target.closest(".cutscene__ask")) this.advance?.();
    });
    window.addEventListener("keydown", (event) => {
      if (!this.playing) return;
      // While the player is typing an answer, only Esc belongs to the cutscene.
      if ((event.target as HTMLElement | null)?.closest?.(".cutscene__ask") && event.key !== "Escape") {
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === "Escape") this.skip();
      else if ((event.key === " " || event.key === "Enter") && this.askForm.hidden) this.advance?.();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async play(scene: Cutscene, stage: CutsceneStage): Promise<void> {
    this.playing = true;
    this.skipped = false;
    this.root.hidden = false;
    this.root.classList.add("is-on");
    try {
      for (const step of scene.steps) {
        if (this.skipped) break;
        if (step.when && !stage.flags[step.when]) continue;
        await this.run(step, stage);
      }
    } finally {
      this.subtitle.hidden = true;
      this.askForm.hidden = true;
      this.card.hidden = true;
      this.veil.className = "cutscene__veil";
      this.root.classList.remove("is-on");
      await sleep(350);
      this.root.hidden = true;
      this.playing = false;
      this.advance = null;
    }
  }

  private skip(): void {
    this.skipped = true;
    this.advance?.();
  }

  private async run(step: CutsceneStep, stage: CutsceneStage): Promise<void> {
    if (step.camera) stage.focus(step.camera.focus, step.camera.zoom);
    if (step.place) stage.placeActor(step.place.who, step.place.cell);
    if (step.toast) stage.toast(step.toast);
    if (step.call) stage.trigger(step.call);
    if (step.effect) await this.effect(step.effect);
    if (step.wait) await this.pause(step.wait * 1000);
    if (step.title) {
      this.card.textContent = step.title.text;
      this.card.hidden = false;
      await this.pause(step.title.seconds * 1000);
      this.card.hidden = true;
    }
    if (step.walk) {
      const to = step.walk.to ?? (step.walk.near ? stage.cellNear(step.walk.near) : null);
      if (to) {
        const walking = stage.walkActor(step.walk.who, to, step.walk.run ?? false);
        if (step.walk.wait !== false) await Promise.race([walking, this.untilSkipped()]);
      }
    }
    if (step.say) await this.say(step.say.who, step.say.text, stage);
    if (step.ask) await this.ask(step.ask, stage);
  }

  /** An interactive beat: the player answers the NPC in English; the NPC replies in the moment. */
  private async ask(step: NonNullable<CutsceneStep["ask"]>, stage: CutsceneStage): Promise<void> {
    const note = `${step.context} The player's task right now: ${step.goal}`;
    const name = stage.actorName(step.who);
    this.askGoal.textContent = step.goal;
    this.askFeedback.textContent = "";
    this.askFeedback.className = "cutscene__feedback";
    this.askInput.value = "";
    this.askContinue.hidden = true;
    this.askForm.hidden = false;
    this.askInput.focus();
    let attempts = 0;

    const reply = await new Promise<TurnResponse | null>((resolve) => {
      const finish = (value: TurnResponse | null) => {
        this.askForm.onsubmit = null;
        this.askHint.onclick = null;
        this.askContinue.onclick = null;
        this.advance = null;
        resolve(value);
      };
      this.advance = () => finish(null); // Esc (skip) ends the beat too
      this.askHint.onclick = () => {
        this.askFeedback.className = "cutscene__feedback";
        this.askFeedback.textContent = `For example: "${step.hint}"`;
        this.askInput.focus();
      };
      this.askContinue.onclick = () => finish(null);
      this.askForm.onsubmit = (event) => {
        event.preventDefault();
        const text = this.askInput.value.trim();
        if (!text || this.askSend.disabled) return;
        this.askSend.disabled = true;
        this.askInput.disabled = true;
        this.askFeedback.className = "cutscene__feedback";
        this.askFeedback.textContent = `${name} is listening…`;
        stage.converse(step.who, text, note).then((result) => {
          if (result.accepted && result.response_speaker === "npc") {
            finish(result);
            return;
          }
          attempts += 1;
          this.askFeedback.className = "cutscene__feedback is-coach";
          this.askFeedback.textContent = result.correction && result.correction !== text
            ? `Almost! Try: "${result.correction}"`
            : result.npc_response;
          this.askContinue.hidden = attempts < ASK_ATTEMPTS_BEFORE_CONTINUE;
        }, (error: unknown) => {
          this.askFeedback.className = "cutscene__feedback is-error";
          this.askFeedback.textContent = error instanceof Error ? error.message : "Something went wrong.";
          this.askContinue.hidden = false;
        }).finally(() => {
          this.askSend.disabled = false;
          this.askInput.disabled = false;
          this.askInput.value = this.askFeedback.className.includes("is-coach") ? this.askInput.value : "";
          this.askInput.focus();
        });
      };
    });

    this.askForm.hidden = true;
    if (reply && !this.skipped) await this.say(step.who, reply.npc_response, stage);
  }

  private async say(who: string, text: string, stage: CutsceneStage): Promise<void> {
    this.speaker.textContent = stage.actorName(who).toUpperCase();
    this.line.textContent = text;
    this.subtitle.hidden = false;
    const readMs = 1200 + text.split(/\s+/).length * 320;
    const spoken = stage.speak(who, text).then(() => sleep(400), () => sleep(readMs));
    await sleep(500); // never flash a line past
    await Promise.race([spoken, this.waitForAdvance()]);
    this.subtitle.hidden = true;
  }

  private async effect(kind: NonNullable<CutsceneStep["effect"]>): Promise<void> {
    if (kind === "flash") {
      this.veil.className = "cutscene__veil is-flash";
      await sleep(180);
      this.veil.className = "cutscene__veil";
      await sleep(250);
    } else if (kind === "fade_out") {
      this.veil.className = "cutscene__veil is-dark";
      await sleep(700);
    } else {
      this.veil.className = "cutscene__veil";
      await sleep(600);
    }
  }

  /** Wait, but let Space/click/Esc cut the pause short. */
  private pause(ms: number): Promise<void> {
    return Promise.race([sleep(ms), this.waitForAdvance()]);
  }

  private waitForAdvance(): Promise<void> {
    if (this.skipped) return Promise.resolve();
    return new Promise((resolve) => {
      this.advance = () => {
        this.advance = null;
        resolve();
      };
    });
  }

  private untilSkipped(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => (this.skipped ? resolve() : window.setTimeout(check, 100));
      check();
    });
  }
}
