import "server-only";

/**
 * The demo shop behind VETRINA_SOURCE=fixture: the real homepage's blocks
 * (same paths, titles and rails as resellpiacenza.shop's front page) over a
 * generated catalogue of sneakers. Deterministic — the same demo every start.
 */

export interface DemoProduct {
  id: number;
  sku: string;
  name: string;
  brand: string; // brand term slug
  categories: string[]; // product_cat slugs
  tags: string[]; // product_tag slugs
  price: number;
  onSale: boolean;
  created: string; // ISO
  /** When the product last changed (epoch ms): the automatic categories ask for what changed. */
  modified: number;
  menuOrder: number;
  totalSales: number;
  inStock: boolean;
  image: string;
}

/** Brand tree: child → parent (a brand rail includes its sub-brands). */
export const DEMO_BRAND_PARENT: Record<string, string | null> = {
  nike: null,
  "nike-off-white": "nike",
  "nike-air-force-1": "nike",
  "nike-dunk": "nike",
  adidas: null,
  "adidas-samba": "adidas",
  "new-balance": null,
  asics: null,
};

/**
 * Term ids, so the demo shop's categories and brands can be addressed the way
 * the real ones are — by id — by the automatic categories (collections/
 * fixture-client.ts) and the rails that show them.
 */
export const DEMO_TERM_IDS: Record<string, number> = {
  "featured-sneakers-originali-streetwear": 101,
  "saldi-sneakers-outlet": 102,
  "saldi-sneakers-in-offerta": 103,
  "new-nuove-release": 104,
  nike: 201,
  "nike-off-white": 202,
  "nike-air-force-1": 203,
  "nike-dunk": 204,
  adidas: 205,
  "adidas-samba": 206,
  "new-balance": 207,
  asics: 208,
};

/** The demo shop's tags, by slug: what the automatic categories can be told to follow. */
export const DEMO_TAGS: { id: number; slug: string; name: string }[] = [
  { id: 301, slug: "saldi", name: "saldi" },
  { id: 302, slug: "estate", name: "estate" },
  { id: 303, slug: "esclusiva", name: "esclusiva" },
];

export const DEMO_TERM_NAMES: Record<string, string> = {
  "featured-sneakers-originali-streetwear": "Prodotti in tendenza",
  "saldi-sneakers-outlet": "Saldi outlet",
  "saldi-sneakers-in-offerta": "Sneakers in offerta",
  "new-nuove-release": "Nuove release",
  nike: "Nike",
  "nike-off-white": "Nike Off-White",
  "nike-air-force-1": "Nike Air Force 1",
  "nike-dunk": "Nike Dunk",
  adidas: "Adidas",
  "adidas-samba": "Adidas Samba",
  "new-balance": "New Balance",
  asics: "Asics",
};

const MODELS: { brand: string; name: string; price: number; tint: string }[] = [
  { brand: "nike-off-white", name: "Off-White x Nike Dunk Low Lot", price: 260, tint: "#e4e4e7" },
  { brand: "nike-off-white", name: "Off-White x Air Jordan 1 Chicago", price: 420, tint: "#fee2e2" },
  { brand: "nike-air-force-1", name: "Nike Air Force 1 Low '07 White", price: 119, tint: "#f4f4f5" },
  { brand: "nike-air-force-1", name: "Nike Air Force 1 Triple Black", price: 129, tint: "#d4d4d8" },
  { brand: "nike-dunk", name: "Nike Dunk Low Panda", price: 139, tint: "#e5e7eb" },
  { brand: "adidas-samba", name: "adidas Samba OG Cloud White", price: 129, tint: "#ecfccb" },
  { brand: "adidas", name: "adidas Gazelle Indoor Blue", price: 139, tint: "#dbeafe" },
  { brand: "adidas", name: "adidas Campus 00s Grey", price: 119, tint: "#e2e8f0" },
  { brand: "new-balance", name: "New Balance 9060 Sea Salt", price: 179, tint: "#fef3c7" },
  { brand: "new-balance", name: "New Balance 1906R Silver", price: 169, tint: "#e5e7eb" },
  { brand: "asics", name: "ASICS Gel-Kayano 14 Cream", price: 169, tint: "#fef9c3" },
  { brand: "asics", name: "ASICS Gel-NYC Graphite", price: 149, tint: "#d6d3d1" },
];

const COLORWAYS = ["Black", "White", "Grey Fog", "University Red", "Sail", "Olive"];

/** mulberry32: a tiny seeded PRNG, so the demo is the same on every start. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sneaker-ish card image as an inline SVG — no network, no stock photos. */
function demoImage(label: string, tint: string): string {
  const safe = label.replace(/[<&>"']/g, "");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">` +
    `<rect width="300" height="300" fill="${tint}"/>` +
    `<path d="M40 190c30 0 55-8 78-30l22-22c8-8 20-6 26 3l10 16c10 14 26 22 44 24l26 3c10 1 14 8 14 16v6H40z" fill="#18181b" opacity=".85"/>` +
    `<rect x="40" y="212" width="220" height="12" rx="6" fill="#fafafa" opacity=".9"/>` +
    `<text x="150" y="262" font-family="system-ui,sans-serif" font-size="17" font-weight="600" text-anchor="middle" fill="#3f3f46">${safe}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function demoProducts(): DemoProduct[] {
  const random = rng(20260930);
  // A second sequence for what was added later (tags), so the first one —
  // and with it every demo product as it always was — stays the same.
  const later = rng(20261005);
  const now = Date.parse("2026-09-30T12:00:00Z");
  const out: DemoProduct[] = [];
  let id = 1001;
  MODELS.forEach((model) => {
    COLORWAYS.forEach((colorway, v) => {
      const categories: string[] = [];
      if (random() < 0.34) categories.push("featured-sneakers-originali-streetwear");
      if (random() < 0.28) categories.push("saldi-sneakers-outlet");
      if (random() < 0.28) categories.push("saldi-sneakers-in-offerta");
      if (random() < 0.34) categories.push("new-nuove-release");
      const label = `${model.name.split(" ").slice(-2).join(" ")} · ${colorway}`;
      const tags = DEMO_TAGS.filter(() => later() < 0.22).map((t) => t.slug);
      const created = now - Math.floor(random() * 120) * 86_400_000;
      out.push({
        id,
        sku: `${model.brand.slice(0, 3).toUpperCase()}${String(id).slice(-3)}-${v + 1}`,
        name: `${model.name} ${colorway}`,
        brand: model.brand,
        categories,
        tags,
        price: Math.round(model.price + (random() - 0.3) * 60) + 0.99,
        onSale: categories.includes("saldi-sneakers-outlet"),
        created: new Date(created).toISOString(),
        modified: created,
        menuOrder: id % 5 === 0 ? 0 : 1 + Math.floor(random() * 60),
        totalSales: Math.floor(random() * 300),
        inStock: id % 9 !== 0,
        image: demoImage(label, model.tint),
      });
      id += 1;
    });
  });
  return out;
}

/** One block of the demo homepage — the real page's leaf blocks, in order. */
export type DemoBlock =
  | {
      path: string;
      name: string;
      kind: "rail";
      title: string;
      eyebrow: string;
      background: string;
      button: { text: string; url: string };
      atts: Record<string, string>;
    }
  | { path: string; name: string; kind: "static"; title: string | null; items: number | null; labels: string[] };

function rail(
  path: string,
  title: string,
  eyebrow: string,
  term: { category?: string; brand?: string },
  limit: number,
  columns: number,
  background = "white",
  button = { text: "", url: "" },
): DemoBlock {
  const atts: Record<string, string> = {};
  if (term.category) atts.category = term.category;
  if (term.brand) atts.brand = term.brand;
  atts.limit = String(limit);
  atts.columns = String(columns);
  atts.columns_tablet = "3";
  return { path, name: "golden-hive/shortcode-wrapper", kind: "rail", title, eyebrow, background, button, atts };
}

export const DEMO_BLOCKS: DemoBlock[] = [
  { path: "0", name: "core/html", kind: "static", title: null, items: null, labels: [] },
  {
    path: "2",
    name: "golden-hive/hero-carousel",
    kind: "static",
    title: null,
    items: 5,
    labels: ["AP x SWATCH", "NIKE MIND", "JACQUEMUS", "TRAVIS SCOTT 1", "CORTEIZ"],
  },
  {
    path: "4",
    name: "golden-hive/trust-badges",
    kind: "static",
    title: null,
    items: 5,
    labels: ["100% Autentico", "Spedizione Express", "Reso 14 Giorni", "Pagamenti Sicuri", "+500 Recensioni"],
  },
  { path: "6", name: "core/shortcode", kind: "static", title: '[wd_hustle id="3" type="embedded"/]', items: null, labels: [] },
  rail("8.0", "PRODOTTI IN TENDENZA", "Selezione Esclusiva", { category: "featured-sneakers-originali-streetwear" }, 18, 4, "gray", { text: "Esplora le tendenze", url: "" }),
  rail("8.1", "SALDI", "Saldi primaverili", { category: "saldi-sneakers-outlet" }, 18, 4),
  rail("8.2", "SNEAKERS", "Offerte speciale", { category: "saldi-sneakers-in-offerta" }, 18, 4),
  {
    path: "8.3",
    name: "golden-hive/category-slider",
    kind: "static",
    title: null,
    items: 7,
    labels: ["Asics", "Essentials", "New Balance", "Nocta", "Samba & Gazelle", "Travis Scott", "59FIFTY"],
  },
  rail("8.4", "NUOVI ARRIVI", "Release aggiornate", { category: "new-nuove-release" }, 18, 5, "white", { text: "Nuove Release", url: "/product-category/new-nuove-release" }),
  rail("8.5", "Nike Off-White", "Design Milanese", { brand: "nike-off-white" }, 15, 5, "white", { text: "Esplora Nike Off-White", url: "/marchio/nike/nike-off-white" }),
  rail("8.6", "Nike Air Force 1", "Il classico incontra l'hype", { brand: "nike-air-force-1" }, 15, 5, "white", { text: "Esplora Nike Air Force", url: "/marchio/nike/nike-air-force-1" }),
  {
    path: "10",
    name: "golden-hive/brand-marquee",
    kind: "static",
    title: "SHOP BY BRAND",
    items: 7,
    labels: ["Nike", "Jordan", "Adidas", "New Balance", "Corteiz", "Travis Scott", "Timberland"],
  },
  rail("12.0", "ADIDAS", "Campus, Gazelle, Samba, Spezial", { brand: "adidas" }, 15, 5, "gray", { text: "Esplora Adidas", url: "/marchio/adidas" }),
  rail("12.1", "NEW BALANCE", "NB 9060, 1906R, NB 550, 530, NB 2002, 2041", { brand: "new-balance" }, 15, 5, "gray", { text: "Esplora New Balance", url: "/marchio/new-balance" }),
  rail("12.2", "ASICS", "Gel Kayano, NYC, 1130, GT", { brand: "asics" }, 15, 5, "gray", { text: "Esplora Asics", url: "/marchio/asics" }),
  {
    path: "14",
    name: "golden-hive/faq-schema",
    kind: "static",
    title: null,
    items: 5,
    labels: [
      "Come posso essere sicuro che i prodotti siano autentici?",
      "Quali sono i tempi di spedizione?",
      "Posso restituire o cambiare un prodotto?",
      "Come posso tracciare il mio ordine?",
      "Quali metodi di pagamento accettate?",
    ],
  },
  { path: "16", name: "golden-hive/social-buttons", kind: "static", title: null, items: null, labels: [] },
  {
    path: "18",
    name: "golden-hive/social-proof",
    kind: "static",
    title: null,
    items: 7,
    labels: ["Air Jordan 4 Retro", "Nike Dunk Low Panda", "New Balance 550", "Yeezy 350 V2", "Adidas Samba", "Corteiz Hoodie", "New Era 59Fifty"],
  },
  { path: "20", name: "golden-hive/whatsapp-button", kind: "static", title: null, items: null, labels: [] },
];
