import type { Appointment, PhoneMessage, PhoneThread, PraglishApiClient, TurnResponse } from "../services/PraglishApiClient";
import "./phone.css";

const PHONE_ICON = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 18.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const POLL_MS = 15_000;

export interface PhoneEvents {
  onClose(): void;
  /** A reply came back through the turn pipeline (rewards, relationship, quests). */
  onTurn?(result: TurnResponse): void;
}

/**
 * The player's phone (Kademe 2): a text thread with Sam. Opens with M or the
 * phone button; the button carries a badge for unread messages. Messages go
 * through the same turn pipeline as face-to-face conversations.
 */
export class PhonePanel {
  readonly button: HTMLButtonElement;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly status: HTMLElement;
  private readonly planBar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
  private thread: PhoneThread | null = null;
  private busy = false;
  private timer = 0;

  constructor(
    container: HTMLElement,
    private readonly api: PraglishApiClient,
    private readonly contact: string,
    private readonly events: PhoneEvents,
  ) {
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "town-phone-button";
    this.button.setAttribute("aria-label", "Open phone (M)");
    this.button.innerHTML = `${PHONE_ICON}<span class="town-phone-button__badge" hidden></span>`;
    container.appendChild(this.button);
    const badge = this.button.querySelector<HTMLElement>(".town-phone-button__badge");
    if (!badge) throw new Error("Phone badge missing");
    this.badge = badge;

    this.root = document.createElement("section");
    this.root.className = "town-phone";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Phone");
    this.root.innerHTML = `
      <header class="town-phone__head">
        <span class="town-phone__avatar" aria-hidden="true"></span>
        <div><strong data-contact></strong><small>Messages</small></div>
        <button type="button" class="town-phone__close" aria-label="Close phone">✕</button>
      </header>
      <p class="town-phone__plan" hidden></p>
      <div class="town-phone__list" aria-live="polite"></div>
      <p class="town-phone__status" role="status"></p>
      <form class="town-phone__form">
        <input type="text" maxlength="240" autocomplete="off" placeholder="Text in English…" aria-label="Message" />
        <button type="submit">Send</button>
      </form>`;
    container.appendChild(this.root);
    const q = <T extends Element>(selector: string): T => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`PhonePanel is missing ${selector}`);
      return el;
    };
    this.list = q(".town-phone__list");
    this.status = q(".town-phone__status");
    this.planBar = q(".town-phone__plan");
    this.input = q("input");
    this.send = q(".town-phone__form button");
    q<HTMLElement>("[data-contact]").textContent = contact;

    this.button.addEventListener("click", () => (this.isOpen ? this.close() : this.requestOpen()));
    q<HTMLButtonElement>(".town-phone__close").addEventListener("click", () => this.close());
    q<HTMLFormElement>(".town-phone__form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      event.stopPropagation(); // typing never moves the player
    });
  }

  /** Set by the town so opening goes through its single active-panel slot. */
  requestOpen: () => void = () => this.open();

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Upcoming meetings with this contact, shown pinned above the thread. */
  setPlans(plans: readonly Appointment[]): void {
    const next = plans.find((p) => p.status === "planned" && p.npc_name === this.contact);
    this.planBar.hidden = !next;
    this.planBar.textContent = next ? `📅 ${next.place_name} · ${next.label}` : "";
  }

  startPolling(): void {
    void this.refresh();
    this.timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void this.refresh();
    }, POLL_MS);
  }

  open(): void {
    this.root.hidden = false;
    this.button.setAttribute("aria-pressed", "true");
    this.render();
    void this.refresh();
    this.input.focus();
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.button.setAttribute("aria-pressed", "false");
    this.events.onClose();
  }

  /** Reload the thread; marks it read while the phone is open. */
  async refresh(): Promise<void> {
    try {
      const thread = await this.api.getPhoneThread(this.contact);
      this.thread = thread;
      if (this.isOpen) {
        await this.markRead();
        this.render();
      }
      this.updateBadge();
    } catch {
      if (this.isOpen && !this.thread) this.status.textContent = "No signal. Is the API running?";
    }
  }

  private async markRead(): Promise<void> {
    const messages = this.thread?.messages ?? [];
    const last = messages[messages.length - 1];
    if (!this.thread || !last || this.thread.unread === 0) return;
    await this.api.markPhoneRead(this.contact, last.id).catch(() => undefined);
    this.thread.unread = 0;
    this.thread.seen_id = last.id;
  }

  private updateBadge(): void {
    const unread = this.isOpen ? 0 : this.thread?.unread ?? 0;
    this.badge.hidden = unread === 0;
    this.badge.textContent = unread > 9 ? "9+" : String(unread);
    this.button.setAttribute("aria-label", unread ? `Open phone (M), ${unread} new` : "Open phone (M)");
  }

  private render(): void {
    const messages = this.thread?.messages ?? [];
    this.list.replaceChildren(...messages.map((m) => this.bubble(m)));
    if (!messages.length) {
      const empty = document.createElement("p");
      empty.className = "town-phone__empty";
      empty.textContent = this.thread ? `No messages yet. Say hi to ${this.contact}!` : "Connecting…";
      this.list.append(empty);
    }
    this.list.scrollTop = this.list.scrollHeight;
    this.updateBadge();
  }

  private bubble(message: Pick<PhoneMessage, "speaker" | "text"> & { channel?: PhoneMessage["channel"] }): HTMLElement {
    const el = document.createElement("p");
    el.className = `town-phone__msg is-${message.speaker}`;
    if (message.channel === "in_person") {
      el.classList.add("is-in-person");
      const label = document.createElement("small");
      label.textContent = "In person";
      el.append(label);
    }
    el.append(document.createTextNode(message.text));
    return el;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy || !this.thread) return;
    this.busy = true;
    this.input.value = "";
    this.input.disabled = true;
    this.send.disabled = true;
    this.list.querySelector(".town-phone__empty")?.remove();
    this.list.append(this.bubble({ speaker: "user", text }));
    this.list.scrollTop = this.list.scrollHeight;
    this.status.textContent = `${this.contact} is typing…`;
    try {
      const result = await this.api.sendPhoneMessage(this.thread.session_id, text);
      if (result.response_speaker === "coach") {
        // Rejected turns are not part of the thread; show the coach's tip under the message.
        this.list.lastElementChild?.classList.add("is-rejected");
        this.list.append(this.bubble({ speaker: "coach", text: result.correction ? `Try: "${result.correction}"` : result.npc_response }));
        this.status.textContent = "Not sent · try the suggestion";
      } else {
        this.status.textContent = "";
        await this.refresh();
        this.render();
        for (const memory of result.new_memories ?? []) this.list.append(this.bubble({ speaker: "coach", text: memory }));
        if (result.plan_update) this.list.append(this.bubble({ speaker: "coach", text: result.plan_update.message }));
      }
      this.events.onTurn?.(result);
    } catch (error: unknown) {
      this.status.textContent = error instanceof Error ? error.message : "Message not sent.";
    } finally {
      this.busy = false;
      this.input.disabled = false;
      this.send.disabled = false;
      this.input.focus();
      this.list.scrollTop = this.list.scrollHeight;
    }
  }

  dispose(): void {
    window.clearInterval(this.timer);
  }
}
