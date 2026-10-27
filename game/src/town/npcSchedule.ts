import type { Cell } from "./townMap";

/** Where an NPC wants to be between two clock times ("HH:MM", may wrap past midnight). */
export interface ScheduleEntry {
  from: string;
  to: string;
  cell: Cell;
}

export function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Bad schedule time: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) throw new Error(`Bad schedule time: ${value}`);
  return (hours * 60 + minutes) % 1440;
}

function covers(entry: ScheduleEntry, minute: number): boolean {
  const from = parseClock(entry.from);
  const to = parseClock(entry.to);
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** The cell an NPC should head for at this minute of the day, or null to stay put. */
export function scheduledCell(schedule: readonly ScheduleEntry[], minute: number): Cell | null {
  return schedule.find((entry) => covers(entry, minute))?.cell ?? null;
}
