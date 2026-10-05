/**
 * When the in-app scheduler runs: fixed times of day in one time zone (the
 * shop's), so a sync lands at a quiet hour whatever time the server happened
 * to start. Pure — shared by src/server/scheduler.ts and the env check.
 *
 * On the two daylight-saving days a time that falls in the skipped hour runs
 * an hour later, and one in the repeated hour runs once; times outside 02:00–
 * 03:00 are never affected.
 */

/** The shop's time zone unless SCHEDULER_TIMEZONE says otherwise. */
export const DEFAULT_TIMEZONE = "Europe/Rome";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "13:30, 04:30" → ["04:30", "13:30"]: trimmed, de-duplicated, in order. Throws on anything else. */
export function parseTimes(value: string): string[] {
  const times = value.split(",").map((t) => t.trim());
  if (times.some((t) => !TIME.test(t))) {
    throw new Error(`Not a list of HH:MM times: "${value}"`);
  }
  return [...new Set(times)].sort();
}

/** Whether the runtime knows this IANA time zone ("Europe/Rome"). */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function wallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far the zone's clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(new Date(instant), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant the zone's clock reads `time` on `date`. */
function instantOf(date: CalendarDate, time: string, timeZone: string): number {
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // The second pass settles the offset when the first guess crossed a DST change.
  const guess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(guess, timeZone);
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The first scheduled instant strictly after `after`. */
export function nextSlot(after: Date, times: readonly string[], timeZone: string): Date {
  const today = wallClock(after, timeZone);
  for (let days = 0; days <= 2; days++) {
    const date = addDays(today, days);
    for (const time of times) {
      const slot = instantOf(date, time, timeZone);
      if (slot > after.getTime()) return new Date(slot);
    }
  }
  throw new Error("No scheduled time configured.");
}

/** The last scheduled instant at or before `at`. */
export function previousSlot(at: Date, times: readonly string[], timeZone: string): Date {
  const today = wallClock(at, timeZone);
  for (let days = 0; days >= -2; days--) {
    const date = addDays(today, days);
    for (const time of [...times].reverse()) {
      const slot = instantOf(date, time, timeZone);
      if (slot <= at.getTime()) return new Date(slot);
    }
  }
  throw new Error("No scheduled time configured.");
}

/**
 * Whether the most recent slot still has no successful run: the server was
 * down at that time, or the run failed. `lastServed` is the latest slot a
 * successful run was for (null: none ever).
 */
export function slotMissed(lastServed: Date | null, now: Date, times: readonly string[], timeZone: string): boolean {
  return lastServed == null || lastServed.getTime() < previousSlot(now, times, timeZone).getTime();
}

/**
 * After a run in which some steps failed: when to retry them — `delayMs`
 * later, at most `maxRetries` times for one slot, and only while that still
 * leaves `delayMs` before the next slot, which runs every step anyway.
 * Null: nothing to retry, or leave it to the next slot.
 */
export function retryAt(run: {
  failed: number;
  attempt: number;
  now: Date;
  next: Date;
  delayMs: number;
  maxRetries: number;
}): Date | null {
  if (run.failed === 0 || run.attempt >= run.maxRetries) return null;
  const at = run.now.getTime() + run.delayMs;
  return at + run.delayMs <= run.next.getTime() ? new Date(at) : null;
}

/**
 * Every `minutes` minutes on the clock, from midnight: 30 → 00:00, 00:30, …,
 * 23:30. Used as a list of times of day, so an interval shares the slot math
 * above, daylight-saving days included. A step that does not divide the day
 * makes the last gap before midnight shorter.
 */
export function intervalTimes(minutes: number): string[] {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
    throw new Error(`Not an interval in minutes (1–720): ${minutes}`);
  }
  const times: string[] = [];
  for (let m = 0; m < 24 * 60; m += minutes) {
    times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return times;
}

/** The feed cycle's step when the GoldenSneakers API is set and SCHEDULER_FEEDS_MINUTES is not. */
export const DEFAULT_FEEDS_MINUTES = 15;

/**
 * What the scheduled runs write to the store unattended: the whole store's
 * changes (the daily sync too), the feed's products' only (the feed cycle),
 * or nothing.
 */
export type AutoSync = "all" | "feed" | "off";

/**
 * The feed cycle and the automatic store sync, from the settings. A shop with
 * the GoldenSneakers API set keeps its store in step with the feed out of the
 * box: a cycle every DEFAULT_FEEDS_MINUTES that writes the feed's products'
 * price and stock changes — the feed is their source of truth. AUTO_SYNC=on
 * adds the whole store to the daily sync; AUTO_SYNC=off writes nothing, and
 * SCHEDULER_FEEDS_MINUTES=0 stops the cycle.
 */
export function feedSchedule(settings: {
  feedsMinutes: number | undefined;
  autoSync: "on" | "off" | undefined;
  gsConfigured: boolean;
}): { feedsEveryMinutes: number; autoSync: AutoSync } {
  const feedsEveryMinutes = settings.feedsMinutes ?? (settings.gsConfigured ? DEFAULT_FEEDS_MINUTES : 0);
  if (settings.autoSync === "on") return { feedsEveryMinutes, autoSync: "all" };
  if (settings.autoSync === "off" || feedsEveryMinutes === 0) return { feedsEveryMinutes, autoSync: "off" };
  return { feedsEveryMinutes, autoSync: "feed" };
}
