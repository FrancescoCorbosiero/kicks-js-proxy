import { defineHubConfig } from "./schema";

/**
 * Store Hub — code configuration.
 *
 * What the Hub shows and what its users may change is decided HERE, in code,
 * by whoever maintains the shop. The data being edited (the homepage, prices,
 * locks, margins) lives in WordPress and in the Hub's database.
 */
export default defineHubConfig({
  ui: {
    landing: "/vetrina",
    nav: ["/vetrina", "/", "/catalog", "/orders", "/pricing", "/sync", "/publish", "/import", "/taxonomies", "/feeds"],
  },

  vetrina: {
    source: "wordpress",
    theme: "ios",
    page: "front",
    blocks: {
      // Product rails: order and hide products. Titles, eyebrows and limits
      // stay read-only for now (the plugin writes only these three).
      "golden-hive/shortcode-wrapper": { show: "rail", edit: { pins: true, exclude: true, fallback: true } },
      "golden-hive/hero-carousel": { show: "summary" },
      "golden-hive/category-slider": { show: "summary" },
      "golden-hive/brand-marquee": { show: "summary" },
      "golden-hive/trust-badges": { show: "summary" },
      "golden-hive/faq-schema": { show: "summary" },
      "*": { show: "hidden" },
    },
    fallbacks: ["menu_order", "date", "popularity"],
    maxPins: 60,
    pageSize: 60,
  },
});
