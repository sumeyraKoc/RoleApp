import type { DashboardData } from "../services/PraglishApiClient";
import { PraglishApiClient } from "../services/PraglishApiClient";
import "./progress.css";

type DashboardPage = "overview" | "grammar" | "vocabulary" | "idioms";

export class ProgressPanel {
  private readonly api = new PraglishApiClient();
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private dashboard: DashboardData | null = null;
  private currentPage: DashboardPage = "overview";

  constructor(container: HTMLElement, private readonly onClose: () => void) {
    this.root = document.createElement("section");
    this.root.className = "town-progress";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Progress Journal");
    this.root.innerHTML = `
      <div class="progress-dashboard">
        <header class="progress-header">
          <div><strong>PROGRESS JOURNAL</strong><span>MY LEARNING JOURNEY</span></div>
          <button type="button" class="paper-close" data-action="close">CLOSE · ESC</button>
        </header>
        <nav class="paper-tabs" aria-label="Journal pages">
          <button type="button" data-page="overview">PROFILE</button>
          <button type="button" data-page="grammar">GRAMMAR</button>
          <button type="button" data-page="vocabulary">WORDS</button>
          <button type="button" data-page="idioms">IDIOMS</button>
        </nav>
        <div class="paper-book" data-dashboard-content aria-live="polite"></div>
      </div>`;
    container.appendChild(this.root);
    const content = this.root.querySelector<HTMLElement>("[data-dashboard-content]");
    if (!content) throw new Error("Progress content is missing");
    this.content = content;
    this.root.querySelector<HTMLButtonElement>("[data-action='close']")?.addEventListener("click", () => this.close());
    this.root.querySelector(".paper-tabs")?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-page]");
      const page = button?.dataset["page"] as DashboardPage | undefined;
      if (!page) return;
      this.currentPage = page;
      this.renderPage();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      event.stopPropagation();
    });
  }

  get isOpen(): boolean { return !this.root.hidden; }

  open(): void {
    this.root.hidden = false;
    this.content.innerHTML = '<div class="paper-empty">Opening journal…</div>';
    this.root.querySelector<HTMLButtonElement>("[data-action='close']")?.focus();
    void this.api.getDashboard().then((data) => {
      if (!this.isOpen) return;
      this.dashboard = data;
      this.renderPage();
    }).catch((error: unknown) => {
      if (!this.isOpen) return;
      this.content.textContent = error instanceof Error ? error.message : "Could not load the journal.";
      this.content.classList.add("paper-empty");
    });
  }

  close(): void {
    if (!this.isOpen) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) focused.blur();
    this.root.hidden = true;
    this.onClose();
  }

  private renderPage(): void {
    if (!this.dashboard) return;
    this.content.classList.remove("paper-empty");
    this.root.querySelectorAll("[data-page]").forEach((tab) => {
      const selected = (tab as HTMLElement).dataset["page"] === this.currentPage;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-current", selected ? "page" : "false");
    });
    const data = this.dashboard;
    if (this.currentPage === "grammar") this.content.innerHTML = this.renderGrammar(data);
    else if (this.currentPage === "vocabulary") this.content.innerHTML = this.renderVocabulary(data);
    else if (this.currentPage === "idioms") this.content.innerHTML = this.renderIdioms(data);
    else this.content.innerHTML = this.renderOverview(data);
  }

  private renderOverview(data: DashboardData): string {
    const maxDaily = Math.max(1, ...data.weekly_activity.map((day) => day.correct + day.incorrect));
    const bars = data.weekly_activity.map((day) => {
      const correctHeight = Math.round(day.correct / maxDaily * 90);
      const incorrectHeight = Math.round(day.incorrect / maxDaily * 90);
      return `<div class="week-column" title="${day.date}: ${day.correct} correct, ${day.incorrect} incorrect">
        <div class="week-bars"><i class="correct" style="height:${correctHeight}px"></i><i class="incorrect" style="height:${incorrectHeight}px"></i></div>
        <small>${this.escapeHtml(day.date.slice(5))}</small>
      </div>`;
    }).join("");
    const locations = data.locations.length
      ? data.locations.map((item) => `<li><span>${this.escapeHtml(item.name)}</span><b>${item.turn_count}</b></li>`).join("")
      : '<li class="muted">No room activity has been recorded yet.</li>';

    return this.bookPages(
      "PROFILE",
      `<div class="pixel-avatar">🙂</div>
       <h2>${this.escapeHtml(this.displayName(data.profile.username))}</h2>
       <div class="level-ribbon">LEVEL ${data.profile.level}</div>
       ${this.statGrid([
         ["XP", data.profile.xp], ["COINS", data.profile.coins],
         ["WORDS", data.summary.words_learned], ["IDIOMS", data.summary.idioms_discovered],
       ])}`,
      "7 DAY JOURNEY",
      `<div class="success-score"><strong>%${data.summary.success_percent}</strong><span>SUCCESS</span></div>
       <div class="week-chart">${bars}</div>
       <ul class="location-list">${locations}</ul>`,
    );
  }

  private renderGrammar(data: DashboardData): string {
    const topics = [...data.grammar_topics].sort((a, b) => a.topic_id - b.topic_id);
    return this.bookPages(
      "SPELL BOOK 01-25",
      this.grammarCards(topics.slice(0, 25)),
      "SPELL BOOK 26-50",
      this.grammarCards(topics.slice(25, 50)),
    );
  }

  private renderVocabulary(data: DashboardData): string {
    const maxLevel = Math.max(1, ...data.vocabulary_levels.map((item) => item.count));
    const levels = data.vocabulary_levels.map((item) => `
      <div class="paper-meter"><span>${this.escapeHtml(item.name)}</span><i><b style="width:${Math.round(item.count / maxLevel * 100)}%"></b></i><strong>${item.count}</strong></div>
    `).join("");
    const maxError = Math.max(1, ...data.vocabulary_errors.map((item) => item.count));
    const errors = data.vocabulary_errors.map((item) => `
      <div class="paper-meter error"><span>${this.escapeHtml(this.prettyLabel(item.name))}</span><i><b style="width:${Math.round(item.count / maxError * 100)}%"></b></i><strong>${item.count}</strong></div>
    `).join("");
    return this.bookPages("WORD LEVELS", levels, "MONSTERS TO BEAT", errors);
  }

  private renderIdioms(data: DashboardData): string {
    const discovered = data.idioms.filter((idiom) => idiom.correct_count > 0);
    const practice = data.idioms.filter((idiom) => idiom.incorrect_count > 0);
    return this.bookPages(
      "BADGE COLLECTION",
      this.idiomCards(discovered, "No idioms have been used correctly yet."),
      "TRAINING LIST",
      this.idiomCards(practice, "No idiom mistakes have been found yet."),
    );
  }

  private bookPages(leftTitle: string, left: string, rightTitle: string, right: string): string {
    return `<section class="paper-page left"><h1>${leftTitle}</h1><div class="paper-scroll">${left}</div></section>
      <div class="book-spine"></div>
      <section class="paper-page right"><h1>${rightTitle}</h1><div class="paper-scroll">${right}</div></section>`;
  }

  private statGrid(items: [string, number][]): string {
    return `<div class="paper-stat-grid">${items.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`;
  }

  private grammarCards(items: DashboardData["grammar_topics"]): string {
    return `<div class="grammar-grid">${items.map((topic) => {
      const total = topic.correct_count + topic.incorrect_count;
      const tone = topic.incorrect_count > 0 ? "bad" : total > 0 ? "good" : "unseen";
      const score = total > 0
        ? `✓ ${topic.correct_count} · ✕ ${topic.incorrect_count}`
        : "NOT SEEN YET";
      return `<article class="grammar-card ${tone}">
      <b>#${topic.topic_id} ${this.escapeHtml(topic.topic_name)}</b>
      <span>${score}</span><i style="width:${topic.mastery_percent}%"></i>
    </article>`;
    }).join("")}</div>`;
  }

  private idiomCards(items: DashboardData["idioms"], empty: string): string {
    if (items.length === 0) return `<div class="paper-empty">${empty}</div>`;
    return items.map((idiom) => `<article class="idiom-card"><span>◆</span><div><b>${this.escapeHtml(idiom.display_idiom)}</b><small>✓ ${idiom.correct_count} · ✕ ${idiom.incorrect_count}</small></div></article>`).join("");
  }

  private displayName(username: string): string {
    return username.startsWith("guest_") ? `PLAYER ${username.slice(-4).toUpperCase()}` : username;
  }

  private prettyLabel(value: string): string {
    return value.replace(/_/g, " ").toUpperCase();
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

}
