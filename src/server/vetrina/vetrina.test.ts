import { beforeEach, describe, expect, it, vi } from "vitest";
import homepageJson from "./__fixtures__/wp-homepage.json";
import railJson from "./__fixtures__/wp-rail.json";
import capabilitiesJson from "./__fixtures__/wp-capabilities.json";
import { parseCapabilities, parseHomepage, parseRailDetail } from "./schemas";
import { orderIds } from "@/lib/vetrina/order";

// The fixture source reads nothing from env, but source.ts imports it.
vi.mock("@/lib/env", () => ({ env: {} }));

/**
 * Contract: the JSON below was produced by golden-hive-blocks 5.9.0's
 * wc-gh/v1 routes running in real WordPress (the integration harness), so
 * these tests fail the day the plugin and the Hub stop speaking the same shape.
 */
describe("wc-gh/v1 responses parse into the Hub's types", () => {
  it("homepage: every block, rails with their rendered products", () => {
    const home = parseHomepage(homepageJson);
    expect(home.blocks).toHaveLength(19);
    const rails = home.blocks.filter((b) => b.kind === "rail");
    expect(rails.map((b) => (b.kind === "rail" ? b.rail.key : ""))).toEqual([
      "category:featured-sneakers-originali-streetwear#0",
      "category:saldi-sneakers-outlet#0",
      "category:saldi-sneakers-in-offerta#0",
      "category:new-nuove-release#0",
      "brand:nike-off-white#0",
      "brand:nike-air-force-1#0",
      "brand:adidas#0",
      "brand:new-balance#0",
      "brand:asics#0",
    ]);
    const saldi = rails[1].kind === "rail" ? rails[1].rail : null;
    expect(saldi?.path).toBe("8.1");
    expect(saldi?.limit).toBe(18);
    expect(saldi?.fallback).toBe("menu_order");
    expect(saldi?.products[0]).toMatchObject({ stockStatus: "instock", type: expect.any(String) });
    const hero = home.blocks.find((b) => b.name === "golden-hive/hero-carousel");
    expect(hero?.kind === "static" && hero.summary.items).toBe(5);
  });

  it("rail: the automatic order recomputes the list with the site's rule", () => {
    const rail = parseRailDetail(railJson);
    expect(rail.key).toBe("category:saldi-sneakers-outlet#0");
    expect(rail.visible.length).toBe(rail.total);
    expect(orderIds(rail.visible, rail.pin, rail.exclude).slice(0, rail.items.length)).toEqual(
      rail.items.map((i) => i.id),
    );
    expect(rail.items[0].position).toBe(1);
  });

  it("capabilities", () => {
    const caps = parseCapabilities(capabilitiesJson);
    expect(caps.version).toBe("5.9.0");
    expect(caps.features).toContain("block-write");
  });
});

describe("the demo shop keeps the same contract", () => {
  beforeEach(() => {
    delete (globalThis as { __vetrinaDemo?: unknown }).__vetrinaDemo;
  });

  it("publishes pins, refuses a stale write, and records history", async () => {
    const { fixtureSource } = await import("./fixture-source");
    const source = fixtureSource();
    const home = await source.homepage();
    expect(home.blocks).toHaveLength(19);

    const rail = await source.rail("category:saldi-sneakers-outlet#0");
    const pin = rail.visible.slice(-2).reverse();
    const result = await source.writeRail({
      pageId: rail.pageId,
      path: rail.path,
      blockName: "golden-hive/shortcode-wrapper",
      expectedModifiedGmt: rail.modifiedGmt,
      expectedAttrsHash: rail.attrsHash,
      pin,
      exclude: [rail.visible[0]],
      fallback: "date",
    });
    expect(result.changed).toBe(true);
    expect(result.rendered.slice(0, 2)).toEqual(pin);
    expect(result.rendered).not.toContain(rail.visible[0]);
    expect(result.after).toContain(`pin="${pin.join(",")}"`);

    await expect(
      source.writeRail({
        pageId: rail.pageId,
        path: rail.path,
        blockName: "golden-hive/shortcode-wrapper",
        expectedModifiedGmt: rail.modifiedGmt,
        expectedAttrsHash: rail.attrsHash,
        pin: [],
        exclude: [],
        fallback: "menu_order",
      }),
    ).rejects.toMatchObject({ code: "stale" });

    const history = await source.history("category:saldi-sneakers-outlet#0");
    expect(history[0].pin).toEqual(pin);
    expect(history[history.length - 1].pin).toEqual([]);
  });

  it("brand rails include their sub-brands and hide sold-out products", async () => {
    const { fixtureSource } = await import("./fixture-source");
    const rail = await fixtureSource().rail("brand:adidas#0");
    const names = rail.items.map((i) => i.name);
    expect(names.some((n) => n.includes("Samba"))).toBe(true);
    expect(rail.items.every((i) => i.stockStatus === "instock")).toBe(true);
  });
});
