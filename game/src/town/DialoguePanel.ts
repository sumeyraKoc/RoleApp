import { withEcho } from "./voiceFx";
import {
  ROLEPLAY_TTS_PROFILES,
  type PraglishApiClient,
  type NpcRelationship,
  type TurnResponse,
} from "../services/PraglishApiClient";
import { getRememberedDialogue, rememberDialogueMessage } from "../services/RoleplayMemory";
import type { NpcSpec } from "./townMap";

export type DialogueSpeaker = "npc" | "coach";

export interface DialoguePanelEvents {
  /** A reply arrived; `seconds` is a rough reading/speaking time for the speech bubble. */
  onReply(text: string, speaker: DialogueSpeaker, seconds: number): void;
  onClose(): void;
  onAcceptedTurn?(result: TurnResponse): void;
  /** Story context for this turn (e.g. right after a cutscene), passed to the NPC. */
  sceneNote?(): string | null;
}

type MessageKind = "user" | "npc" | "feedback" | "reward" | "memory" | "error";

const BOND_LABELS: Record<string, { icon: string; text: string }> = {
  hostile: { icon: "✖", text: "Hostile" },
  cold: { icon: "❄", text: "Cold" },
  neutral: { icon: "◇", text: "Neutral" },
  friendly: { icon: "♥", text: "Friendly" },
  close: { icon: "★", text: "Close friend" },
};

const MIC_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 17.5V21M8.5 21h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;

/**
 * Conversation panel for one NPC. Talks to the existing backend through
 * PraglishApiClient: /api/session/start, /api/session/{id}/turn, /api/speech/stt, /api/speech/tts.
 */
export class DialoguePanel {
  readonly npc: NpcSpec;
  private readonly api: PraglishApiClient;
  private readonly root: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly status: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
  private readonly mic: HTMLButtonElement;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private recording = false;
  private audio: HTMLAudioElement | null = null;
  private readonly bond: HTMLElement;

  constructor(
    npc: NpcSpec,
    api: PraglishApiClient,
    container: HTMLElement,
    private readonly events: DialoguePanelEvents,
  ) {
    this.npc = npc;
    this.api = api;

    this.root = document.createElement("section");
    this.root.className = "town-dialogue";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", `Conversation with ${npc.name}`);
    this.root.innerHTML = `
      <header class="town-dialogue__head">
        <div><strong data-name></strong><span data-title></span><span class="town-dialogue__bond" data-bond hidden></span></div>
        <button type="button" class="town-dialogue__close" aria-label="Close conversation">Close <kbd>Esc</kbd></button>
      </header>
      <div class="town-dialogue__messages" aria-live="polite"></div>
      <p class="town-dialogue__status" role="status"></p>
      <form class="town-dialogue__form">
        <input type="text" maxlength="240" autocomplete="off" placeholder="Write in English…" />
        <button type="button" class="town-dialogue__mic" aria-label="Record a voice message">${MIC_ICON}</button>
        <button type="submit" class="town-dialogue__send">Send</button>
      </form>`;
    container.appendChild(this.root);

    const q = <T extends Element>(selector: string): T => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`DialoguePanel is missing ${selector}`);
      return el;
    };
    q<HTMLElement>("[data-name]").textContent = npc.name;
    q<HTMLElement>("[data-title]").textContent = `${npc.title} · AI`;
    this.bond = q("[data-bond]");
    this.messages = q(".town-dialogue__messages");
    this.status = q(".town-dialogue__status");
    this.form = q(".town-dialogue__form");
    this.input = q("input");
    this.send = q(".town-dialogue__send");
    this.mic = q(".town-dialogue__mic");
    this.input.setAttribute("aria-label", `English message to ${npc.name}`);

    q<HTMLButtonElement>(".town-dialogue__close").addEventListener("click", () => this.close());
    this.mic.addEventListener("click", () => void this.toggleRecording());
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.recording) {
        this.stopRecording();
        return;
      }
      void this.submitTurn();
    });
    this.root.addEventListener("keydown", (event) => {
      if (!this.isOpen) return;
      if (event.key === "Escape") this.close();
      // Keep typing ("e", "w", …) from moving the player or opening other panels.
      event.stopPropagation();
    });

    this.restoreHistory();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.input.focus();
    this.status.textContent = "Connecting…";
    if (this.npc.id === "sam") this.setBusy(true);
    void this.api.startSession()
      .then(async () => {
        if (this.npc.id === "sam") await this.restoreSamHistory();
        this.status.textContent = "Connected · Speak or write in English";
      })
      .catch((error: unknown) => {
        this.status.textContent = error instanceof Error ? error.message : "Could not connect";
      })
      .finally(() => {
        if (this.npc.id === "sam") this.setBusy(false);
      });
  }

  close(): void {
    if (!this.isOpen) return;
    if (this.recording) this.stopRecording();
    this.audio?.pause();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) focused.blur();
    this.root.hidden = true;
    this.events.onClose();
  }

  private async submitTurn(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.send.disabled) return;
    this.input.value = "";
    this.append("YOU", text, "user");
    this.setBusy(true);
    this.status.textContent = `${this.npc.name} is thinking…`;
    try {
      const result = await this.api.sendTurn(text, this.events.sceneNote?.() ?? null);
      this.renderResult(result);
      this.status.textContent = result.accepted ? "Accepted · Keep going" : "Try the suggested correction";
    } catch (error: unknown) {
      this.append("SYSTEM", error instanceof Error ? error.message : "Something went wrong.", "error");
      this.status.textContent = "Connection error · Is the API running?";
    } finally {
      this.setBusy(false);
      this.input.focus();
    }
  }

  private renderResult(result: TurnResponse): void {
    const coach = result.response_speaker === "coach";
    this.append(
      coach ? "COACH" : this.npc.name.toUpperCase(),
      result.npc_response,
      coach ? "feedback" : "npc",
      true,
      result.used_focus_words ?? [],
    );
    if (!result.accepted && result.correction && result.correction !== result.npc_response) {
      this.append("SUGGESTION", result.correction, "feedback");
    }
    if (result.rewards && (result.rewards.gained_xp > 0 || result.rewards.gained_coins > 0)) {
      this.append("REWARD", `+${result.rewards.gained_xp} XP · +${result.rewards.gained_coins} coins`, "reward");
    }
    for (const change of result.inventory_changes ?? []) {
      this.append("INVENTORY", `${change.quantity > 0 ? "+" : ""}${change.quantity} ${change.name}`, "reward");
    }
    for (const memory of result.new_memories ?? []) this.append("MEMORY", memory, "memory");
    if (result.plan_update) {
      this.append("PLAN", result.plan_update.message, result.plan_update.status === "rejected" ? "error" : "reward");
    }
    if (result.adventure_notice) this.append("SYSTEM", result.adventure_notice, "error");
    if (result.relationship) this.showBond(result.relationship);
    if (result.accepted) this.events.onAcceptedTurn?.(result);
    const seconds = Math.min(12, 2.5 + result.npc_response.split(/\s+/).length * 0.35);
    this.events.onReply(result.npc_response, coach ? "coach" : "npc", seconds);
    void this.speak(result.npc_response, coach);
  }

  /** Show an exchange that happened elsewhere (an interactive cutscene step) in this conversation's log. */
  recordExchange(userText: string, npcText: string): void {
    this.append("YOU", userText, "user");
    this.append(this.npc.name.toUpperCase(), npcText, "npc");
  }

  private showBond(relationship: NpcRelationship): void {
    const label = BOND_LABELS[relationship.tier] ?? { icon: "◇", text: relationship.tier };
    this.bond.textContent = `${label.icon} ${label.text}`;
    this.bond.dataset.tier = relationship.tier;
    this.bond.title = `${this.npc.name} feels ${label.text.toLowerCase()} toward you`;
    this.bond.hidden = false;
  }

  private async speak(text: string, coach: boolean): Promise<void> {
    try {
      const profile = coach ? ROLEPLAY_TTS_PROFILES.coach : ROLEPLAY_TTS_PROFILES[this.npc.voice];
      const blob = await this.api.synthesizeSpeech(text, profile);
      const url = URL.createObjectURL(blob);
      if (this.audio) {
        this.audio.pause();
        URL.revokeObjectURL(this.audio.src);
      }
      const audio = new Audio(url);
      if (!coach && "echo" in profile && profile.echo) withEcho(audio);
      this.audio = audio;
      audio.addEventListener("ended", () => URL.revokeObjectURL(url));
      await audio.play();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Speech could not be generated or played.";
      this.append("SYSTEM", message, "error", false);
      this.status.textContent = "Speech error · See the conversation";
      console.error("NPC speech failed", error);
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.recording) {
      this.stopRecording();
      return;
    }
    if (this.send.disabled || this.mic.disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.status.textContent = "This browser does not support a microphone.";
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      this.chunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        void this.handleRecording(recorder.mimeType || "audio/webm");
      });
      this.recorder = recorder;
      recorder.start();
      this.recording = true;
      this.mic.innerHTML = STOP_ICON;
      this.mic.classList.add("is-recording");
      this.mic.setAttribute("aria-label", "Stop recording and send");
      this.status.textContent = "Recording… Stop when finished or press Send.";
    } catch {
      this.status.textContent = "Microphone permission was denied.";
    }
  }

  private stopRecording(): void {
    this.recorder?.stop();
    this.recording = false;
    this.mic.innerHTML = MIC_ICON;
    this.mic.classList.remove("is-recording");
    this.mic.setAttribute("aria-label", "Record a voice message");
  }

  private async handleRecording(mimeType: string): Promise<void> {
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    if (blob.size === 0) {
      this.status.textContent = "No audio was captured. Try again.";
      return;
    }
    this.mic.disabled = true;
    this.status.textContent = "Transcribing…";
    try {
      const { text } = await this.api.transcribeAudio(blob);
      if (!text.trim()) {
        this.status.textContent = "Nothing was heard. Try again.";
        return;
      }
      this.input.value = text;
      await this.submitTurn();
    } catch (error: unknown) {
      this.append("SYSTEM", error instanceof Error ? error.message : "Speech was not recognized.", "error");
      this.status.textContent = "Speech was not recognized.";
    } finally {
      this.mic.disabled = false;
    }
  }

  /** Sam's phone and spoken turns share the same server-owned timeline. */
  private async restoreSamHistory(): Promise<void> {
    const thread = await this.api.getPhoneThread("sam");
    if (!this.isOpen) return;
    this.messages.replaceChildren();
    if (thread.messages.length === 0) {
      this.showEmptyHint();
      return;
    }
    for (const message of thread.messages) {
      const kind: MessageKind = message.speaker === "user" ? "user" : "npc";
      const author = message.speaker === "user" ? "YOU" : this.npc.name.toUpperCase();
      this.append(message.channel === "phone" ? `${author} · TEXT` : author, message.text, kind, false);
    }
  }

  private restoreHistory(): void {
    const remembered = getRememberedDialogue(this.npc.location);
    if (remembered.length === 0) {
      this.showEmptyHint();
      return;
    }
    for (const m of remembered) this.append(m.author, m.text, m.kind as MessageKind, false);
  }

  private showEmptyHint(): void {
    const hint = document.createElement("p");
    hint.className = "town-dialogue__empty";
    hint.textContent = `Start by saying something to ${this.npc.name} in English. For example: "Hi! What do you recommend today?"`;
    this.messages.append(hint);
  }

  private append(
    author: string,
    text: string,
    kind: MessageKind,
    remember = true,
    focusWords: readonly string[] = [],
  ): void {
    this.messages.querySelector(".town-dialogue__empty")?.remove();
    const row = document.createElement("div");
    row.className = `town-dialogue__msg is-${kind}`;
    const who = document.createElement("strong");
    who.textContent = author;
    const body = document.createElement("span");
    fillWithFocusWords(body, text, focusWords);
    row.append(who, body);
    this.messages.append(row);
    this.messages.scrollTop = this.messages.scrollHeight;
    if (remember) rememberDialogueMessage(this.npc.location, { author, text, kind });
  }

  private setBusy(busy: boolean): void {
    this.input.disabled = busy;
    this.send.disabled = busy;
    this.send.textContent = busy ? "…" : "Send";
  }
}

/**
 * Writes `text` into `el`, wrapping Spell Book words the NPC used in <mark>
 * (same whole-word + simple inflection rule as api/services/spell_book.py).
 */
function fillWithFocusWords(el: HTMLElement, text: string, words: readonly string[]): void {
  const clean = words.map((w) => w.trim()).filter(Boolean);
  if (clean.length === 0) {
    el.textContent = text;
    return;
  }
  const escaped = clean.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\b(?:${escaped.join("|")})(?:s|es|ed|d|ing)?\\b`, "gi");
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) el.append(text.slice(last, start));
    const mark = document.createElement("mark");
    mark.className = "town-focus";
    mark.title = "A word from your Spell Book";
    mark.textContent = match[0];
    el.append(mark);
    last = start + match[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}
