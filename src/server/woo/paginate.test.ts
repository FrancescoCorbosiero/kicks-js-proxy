import { describe, it, expect } from "vitest";
import { MAX_PAGES, pageVerdict } from "./paginate";

const P = 100;

describe("pageVerdict — the loop ends on its own terms, not the remote's", () => {
  it("keeps going while full pages of new rows arrive", () => {
    expect(pageVerdict({ page: 1, rows: P, fresh: P, perPage: P })).toBe("continue");
  });

  it("stops on a short page — the ordinary end of pagination", () => {
    expect(pageVerdict({ page: 1, rows: 12, fresh: 12, perPage: P })).toBe("complete");
    expect(pageVerdict({ page: 3, rows: 0, fresh: 0, perPage: P })).toBe("complete");
  });

  it("stops when the remote repeats rows — it is ignoring ?page", () => {
    // The crash: a full page of rows already collected, forever.
    expect(pageVerdict({ page: 2, rows: P, fresh: 0, perPage: P })).toBe("not-paginating");
    expect(pageVerdict({ page: 9, rows: P, fresh: 3, perPage: P })).toBe("not-paginating");
  });

  it("catches repeats even when the repeated page is short", () => {
    // A store that answers every page with the same 12 rows would otherwise
    // read as "complete" by luck rather than by detection.
    expect(pageVerdict({ page: 2, rows: 12, fresh: 0, perPage: P })).toBe("not-paginating");
  });

  it("stops at the ceiling when rows stay full and genuinely new", () => {
    expect(pageVerdict({ page: MAX_PAGES, rows: P, fresh: P, perPage: P })).toBe("capped");
    expect(pageVerdict({ page: MAX_PAGES - 1, rows: P, fresh: P, perPage: P })).toBe("continue");
  });

  it("never says continue forever: every full-page path has an exit", () => {
    let page = 1;
    // The exact shape that killed the process: full page, all repeats.
    while (pageVerdict({ page, rows: P, fresh: 0, perPage: P }) === "continue") {
      page += 1;
      if (page > 1000) throw new Error("unbounded");
    }
    expect(page).toBe(1);
  });
});
