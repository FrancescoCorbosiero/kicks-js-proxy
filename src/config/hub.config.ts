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
    journey: ["/import", "/catalog", "/publish", "/sync", "/vetrina", "/orders"],
    setup: ["/pricing", "/taxonomies", "/collections", "/feeds"],
  },

  vetrina: {
    source: "wordpress",
    theme: "ios",
    page: "front",
    blocks: {
      // Product rails: order, hide, size, and the section's texts and colour.
      "golden-hive/shortcode-wrapper": {
        show: "rail",
        edit: {
          pins: true,
          exclude: true,
          fallback: true,
          limit: true,
          fields: ["eyebrow", "title", "backgroundColor", "buttonText", "buttonUrl"],
        },
      },
      // Other blocks: their titles. Slides, cards and logos stay in WordPress.
      "golden-hive/hero-carousel": { show: "summary" },
      "golden-hive/category-slider": { show: "summary", edit: { fields: ["title"] } },
      "golden-hive/brand-marquee": { show: "summary", edit: { fields: ["title"] } },
      "golden-hive/trust-badges": { show: "summary" },
      "golden-hive/faq-schema": { show: "summary", edit: { fields: ["title", "subtitle"] } },
      "*": { show: "hidden" },
    },
    fallbacks: ["menu_order", "date", "popularity"],
    maxPins: 60,
    maxLimit: 48,
    pageSize: 60,
  },
});
