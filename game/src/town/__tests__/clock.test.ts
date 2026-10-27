import { describe, expect, it } from "vitest";
import { daylightAt, formatClock, minuteOfDay } from "../gameClock";
import { scheduledCell, type ScheduleEntry } from "../npcSchedule";

describe("game clock", () => {
  it("formats days and minutes", () => {
    expect(formatClock(8 * 3600)).toBe("Day 1 · 08:00");
    expect(formatClock(24 * 3600 + 7 * 3600 + 30 * 60)).toBe("Day 2 · 07:30");
    expect(minuteOfDay(25 * 3600)).toBe(60);
  });

  it("is dark at night and bright at noon", () => {
    expect(daylightAt(2 * 3600).level).toBe(0);
    expect(daylightAt(12 * 3600).level).toBe(1);
    const dusk = daylightAt(19 * 3600).level;
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });
});

describe("npc schedule", () => {
  const home = { x: 1, z: 1 };
  const park = { x: 5, z: 5 };
  const cafe = { x: 9, z: 9 };
  const day: ScheduleEntry[] = [
    { from: "08:00", to: "12:00", cell: park },
    { from: "17:00", to: "22:00", cell: cafe },
    { from: "22:00", to: "08:00", cell: home },
  ];

  it("picks the entry for the time and wraps past midnight", () => {
    expect(scheduledCell(day, 9 * 60)).toEqual(park);
    expect(scheduledCell(day, 18 * 60)).toEqual(cafe);
    expect(scheduledCell(day, 23 * 60)).toEqual(home);
    expect(scheduledCell(day, 3 * 60)).toEqual(home);
    expect(scheduledCell(day, 14 * 60)).toBeNull();
  });
});
