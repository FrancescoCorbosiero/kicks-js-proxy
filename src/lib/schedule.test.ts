import { describe, expect, it } from "vitest";
import {
  feedSchedule,
  intervalTimes,
  isTimeZone,
  nextSlot,
  parseTimes,
  previousSlot,
  retryAt,
  slotMissed,
} from "./schedule";

const ROME = "Europe/Rome";
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("the scheduled times", () => {
  it("reads a list of HH:MM times, in order and once each", () => {
    expect(parseTimes("13:30, 04:30,04:30")).toEqual(["04:30", "13:30"]);
    for (const bad of ["", "4:30", "24:00", "04:60", "04:30,", "04.30"]) {
      expect(() => parseTimes(bad)).toThrow();
    }
    expect(isTimeZone(ROME)).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  it("lands at the shop's 04:30 in summer and in winter time", () => {
    expect(iso(nextSlot(at("2026-07-01T00:00:00Z"), ["04:30"], ROME))).toBe("2026-07-01T02:30:00.000Z");
    expect(iso(nextSlot(at("2026-12-01T10:00:00Z"), ["04:30"], ROME))).toBe("2026-12-02T03:30:00.000Z");
  });

  it("is strictly after: a run at its slot is followed by the next one", () => {
    expect(iso(nextSlot(at("2026-07-01T02:30:00Z"), ["04:30"], ROME))).toBe("2026-07-02T02:30:00.000Z");
    expect(iso(nextSlot(at("2026-07-01T05:00:00Z"), ["04:30", "13:30"], ROME))).toBe("2026-07-01T11:30:00.000Z");
  });

  it("keeps the local time across the daylight-saving changes", () => {
    // 29 March 2026: 02:00 CET jumps to 03:00 CEST.
    expect(iso(nextSlot(at("2026-03-28T12:00:00Z"), ["04:30"], ROME))).toBe("2026-03-29T02:30:00.000Z");
    expect(iso(nextSlot(at("2026-03-28T12:00:00Z"), ["02:30"], ROME))).toBe("2026-03-29T01:30:00.000Z"); // skipped hour: 03:30
    // 25 October 2026: 03:00 CEST falls back to 02:00 CET.
    expect(iso(nextSlot(at("2026-10-24T12:00:00Z"), ["04:30"], ROME))).toBe("2026-10-25T03:30:00.000Z");
    expect(iso(nextSlot(at("2026-10-25T03:30:00Z"), ["04:30"], ROME))).toBe("2026-10-26T03:30:00.000Z");
  });

  it("finds the most recent slot, the slot itself included", () => {
    expect(iso(previousSlot(at("2026-07-01T01:00:00Z"), ["04:30"], ROME))).toBe("2026-06-30T02:30:00.000Z");
    expect(iso(previousSlot(at("2026-07-01T02:30:00Z"), ["04:30"], ROME))).toBe("2026-07-01T02:30:00.000Z");
    expect(iso(previousSlot(at("2026-07-01T12:00:00Z"), ["04:30", "13:30"], ROME))).toBe("2026-07-01T11:30:00.000Z");
  });
});

describe("catching up after downtime", () => {
  const now = at("2026-07-01T09:00:00Z"); // 11:00 in Rome; today's 04:30 has passed
  const today = at("2026-07-01T02:30:00Z");
  const yesterday = at("2026-06-30T02:30:00Z");

  it("runs the missed slot when the server was down, or never ran", () => {
    expect(slotMissed(null, now, ["04:30"], ROME)).toBe(true);
    expect(slotMissed(yesterday, now, ["04:30"], ROME)).toBe(true);
  });

  it("does nothing on a restart after today's run succeeded", () => {
    expect(slotMissed(today, now, ["04:30"], ROME)).toBe(false);
  });
});

describe("retrying failed steps", () => {
  const HOUR = 60 * 60 * 1000;
  const now = at("2026-07-01T02:45:00Z"); // the 04:30 run just ended
  const next = at("2026-07-02T02:30:00Z");
  const policy = { now, next, delayMs: HOUR, maxRetries: 2 };

  it("retries an hour later, twice at most", () => {
    expect(iso(retryAt({ ...policy, failed: 1, attempt: 0 })!)).toBe("2026-07-01T03:45:00.000Z");
    expect(retryAt({ ...policy, failed: 1, attempt: 1 })).not.toBeNull();
    expect(retryAt({ ...policy, failed: 1, attempt: 2 })).toBeNull();
  });

  it("does not retry a clean run, or one the next slot will cover", () => {
    expect(retryAt({ ...policy, failed: 0, attempt: 0 })).toBeNull();
    expect(retryAt({ ...policy, failed: 1, attempt: 0, next: at("2026-07-01T04:30:00Z") })).toBeNull();
  });
});

describe("an interval on the clock", () => {
  it("lists the times of day, from midnight", () => {
    const every30 = intervalTimes(30);
    expect(every30).toHaveLength(48);
    expect(every30.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
    expect(every30.at(-1)).toBe("23:30");
    expect(intervalTimes(45).at(-1)).toBe("23:15");
    expect(() => intervalTimes(0)).toThrow();
    expect(() => intervalTimes(721)).toThrow();
  });

  it("lands on the next half hour, in the shop's time", () => {
    const every30 = intervalTimes(30);
    expect(iso(nextSlot(at("2026-07-01T10:07:00Z"), every30, ROME))).toBe("2026-07-01T10:30:00.000Z");
    expect(iso(nextSlot(at("2026-07-01T10:30:00Z"), every30, ROME))).toBe("2026-07-01T11:00:00.000Z");
  });

  it("keeps going through both daylight-saving nights: forward, never twice, no long gap", () => {
    const every30 = intervalTimes(30);
    for (const [from, to] of [
      ["2026-03-28T20:00:00Z", "2026-03-29T06:00:00Z"], // 02:00 CET jumps to 03:00 CEST
      ["2026-10-24T20:00:00Z", "2026-10-25T06:00:00Z"], // 03:00 CEST falls back to 02:00 CET
    ]) {
      const runs: number[] = [];
      for (let t = at(from); t < at(to); t = nextSlot(t, every30, ROME)) runs.push(t.getTime());
      const gaps = runs.slice(1).map((r, i) => (r - runs[i]) / 60_000);
      expect(Math.min(...gaps)).toBeGreaterThan(0);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(90);
      expect(runs.length).toBeGreaterThanOrEqual(18); // ~20 half hours in 10 hours
    }
  });
});

describe("the feed cycle and the automatic store sync", () => {
  const unset = { feedsMinutes: undefined, autoSync: undefined };

  it("keeps a GoldenSneakers shop's store in step every 15 minutes, out of the box", () => {
    expect(feedSchedule({ ...unset, gsConfigured: true })).toEqual({ feedsEveryMinutes: 15, autoSync: "feed" });
  });

  it("leaves a shop without the feed API alone", () => {
    expect(feedSchedule({ ...unset, gsConfigured: false })).toEqual({ feedsEveryMinutes: 0, autoSync: "off" });
  });

  it("takes the operator's interval, and 0 stops the cycle and its writes", () => {
    expect(feedSchedule({ ...unset, feedsMinutes: 30, gsConfigured: true })).toEqual({
      feedsEveryMinutes: 30,
      autoSync: "feed",
    });
    expect(feedSchedule({ ...unset, feedsMinutes: 0, gsConfigured: true })).toEqual({
      feedsEveryMinutes: 0,
      autoSync: "off",
    });
  });

  it("writes nothing with AUTO_SYNC=off, and the whole store too with AUTO_SYNC=on", () => {
    expect(feedSchedule({ feedsMinutes: undefined, autoSync: "off", gsConfigured: true })).toEqual({
      feedsEveryMinutes: 15,
      autoSync: "off",
    });
    expect(feedSchedule({ feedsMinutes: undefined, autoSync: "on", gsConfigured: true }).autoSync).toBe("all");
    // The daily sync writes the whole store even with no feed cycle at all.
    expect(feedSchedule({ feedsMinutes: 0, autoSync: "on", gsConfigured: false }).autoSync).toBe("all");
  });
});
