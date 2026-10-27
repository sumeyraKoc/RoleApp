import type { ClockState } from "../services/PraglishApiClient";

export const DAY_SECONDS = 24 * 3600;
const SYNC_MS = 15_000;

export interface ClockSource {
  tickClock(): Promise<ClockState>;
}

/** "Day 2 · 07:30" from game seconds since Day 1 00:00. */
export function formatClock(gameSeconds: number): string {
  const day = Math.floor(gameSeconds / DAY_SECONDS) + 1;
  const rest = ((gameSeconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const hh = String(Math.floor(rest / 3600)).padStart(2, "0");
  const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, "0");
  return `Day ${day} · ${hh}:${mm}`;
}

/** Minutes since midnight, 0..1439. */
export function minuteOfDay(gameSeconds: number): number {
  return Math.floor((((gameSeconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS) / 60);
}

export interface Daylight {
  /** 0 = deep night, 1 = full day. */
  level: number;
  skyTop: string;
  skyLow: string;
}

type Rgb = readonly [number, number, number];

const NIGHT_TOP: Rgb = [18, 24, 48];
const NIGHT_LOW: Rgb = [44, 52, 86];
const DAY_TOP: Rgb = [142, 197, 236];
const DAY_LOW: Rgb = [220, 240, 246];
const DUSK: Rgb = [244, 176, 122];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function css(c: Rgb): string {
  return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

/** Light ramps up 05:00–07:00, stays full until 18:00 and fades out by 20:30. */
export function daylightAt(gameSeconds: number): Daylight {
  const h = minuteOfDay(gameSeconds) / 60;
  let level: number;
  if (h < 5 || h >= 20.5) level = 0;
  else if (h < 7) level = (h - 5) / 2;
  else if (h < 18) level = 1;
  else level = 1 - (h - 18) / 2.5;
  // A warm horizon while the sun rises or sets.
  const warmth = Math.sin(level * Math.PI) * 0.55;
  return {
    level,
    skyTop: css(mix(NIGHT_TOP, DAY_TOP, level)),
    skyLow: css(mix(mix(NIGHT_LOW, DAY_LOW, level), DUSK, warmth)),
  };
}

/**
 * Client view of the server-owned clock. The API advances time on each tick;
 * between ticks the client runs the clock forward at the same rate so the HUD
 * moves smoothly. Ticks stop while the tab is hidden, so time pauses there too.
 */
export class GameClock {
  private baseSeconds: number | null = null;
  private baseAt = 0;
  private rate = 30;
  private timer: number | null = null;
  private readonly listeners = new Set<(seconds: number) => void>();

  constructor(private readonly source: ClockSource) {}

  get ready(): boolean {
    return this.baseSeconds !== null;
  }

  /** Current game seconds, interpolated since the last server answer. */
  now(at: number = performance.now()): number {
    if (this.baseSeconds === null) return 8 * 3600;
    return this.baseSeconds + ((at - this.baseAt) / 1000) * this.rate;
  }

  start(): void {
    void this.sync();
    this.timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void this.sync();
    }, SYNC_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.sync();
    });
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Called when the server moved the clock on its own (sleep). */
  apply(state: ClockState): void {
    this.baseSeconds = state.game_seconds;
    this.baseAt = performance.now();
    this.rate = state.game_seconds_per_real_second;
    for (const listener of this.listeners) listener(state.game_seconds);
  }

  onSync(listener: (seconds: number) => void): void {
    this.listeners.add(listener);
  }

  private async sync(): Promise<void> {
    try {
      this.apply(await this.source.tickClock());
    } catch {
      // Keep running locally; the next tick catches up within the server's cap.
    }
  }
}
