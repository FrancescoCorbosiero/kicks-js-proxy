/**
 * Title/brand → navigation metadata, for rows whose source carries none.
 *
 * KicksDB sends category/secondary_category/gender and those always win; but
 * GoldenSneakers rows and Woo store-only rows arrive with a bare title, which
 * left ~everything in "Senza categoria". Product titles in this trade are
 * highly regular ("Nike Air Force 1 Low '07", "adidas Yeezy Foam RNNR Sulfur",
 * "New Balance 550 White Grey", "Air Jordan 4 Retro Military Black"), so a
 * pattern table recovers the same axes KicksDB uses: category = product line,
 * secondaryCategory = the model within it, gender from the title's size-run
 * suffix ("(Women's)", "(GS)", "(PS)", "(TD)").
 *
 * Pure module (no DB, no HTTP) — unit-tested. Patterns are checked in order;
 * first hit wins, so more specific lines come before catch-alls.
 */

export interface DerivedMeta {
  category: string;
  secondaryCategory: string;
  gender: string;
}

interface LineRule {
  /** Case-insensitive test against the full title. */
  test: RegExp;
  category: string;
  /** Literal secondary, or a capture-group index into `test`'s match. */
  secondary?: string | number;
}

/** KicksDB writes Jordan models as words ("One", "Four") — match that vocab
 *  so derived rows land in the same sub-category buckets as enriched ones. */
const JORDAN_MODELS: Record<string, string> = {
  "1": "One", "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six", "7": "Seven",
  "8": "Eight", "9": "Nine", "10": "Ten", "11": "Eleven", "12": "Twelve", "13": "Thirteen",
  "14": "Fourteen",
};

const LINES: LineRule[] = [
  // Jordan: "Air Jordan 4 Retro …", "Jordan 1 Low …"
  { test: /\bjordan\s+(\d+)\b/i, category: "Air Jordan", secondary: 1 },
  { test: /\bjordan\b/i, category: "Air Jordan" },

  // adidas Yeezy family: "Yeezy Foam RNNR", "Yeezy Slide", "Yeezy Boost 350 V2", "Yeezy 500"
  { test: /\byeezy\s+foam\s+(?:rnnr|runner)\b/i, category: "Yeezy", secondary: "Foam RNNR" },
  { test: /\byeezy\s+slide\b/i, category: "Yeezy", secondary: "Slide" },
  { test: /\byeezy\s+(?:boost\s+)?(\d{3})\b/i, category: "Yeezy", secondary: 1 },
  { test: /\byeezy\b/i, category: "Yeezy" },

  // Nike lines
  { test: /\bair\s+force\s*1\b/i, category: "Air Force", secondary: "One" },
  { test: /\bair\s+force\b/i, category: "Air Force" },
  { test: /\bdunk\b/i, category: "Dunk" },
  { test: /\bair\s+max\s+(\w+)\b/i, category: "Air Max", secondary: 1 },
  { test: /\bair\s+max\b/i, category: "Air Max" },
  { test: /\bvapormax\b/i, category: "Air Max", secondary: "VaporMax" },
  { test: /\bblazer\b/i, category: "Blazer" },
  { test: /\bcortez\b/i, category: "Cortez" },
  { test: /\blebron\b/i, category: "LeBron" },
  { test: /\bkobe\b/i, category: "Kobe" },
  { test: /\bkd\s*\d+\b/i, category: "KD" },
  { test: /\bair\s+huarache\b/i, category: "Huarache" },
  { test: /\bshox\b/i, category: "Shox" },
  { test: /\bp-6000\b/i, category: "P-6000" },

  // adidas classics
  { test: /\bsamba\b/i, category: "Samba" },
  { test: /\bgazelle\b/i, category: "Gazelle" },
  { test: /\bcampus\b/i, category: "Campus" },
  { test: /\bforum\b/i, category: "Forum" },
  { test: /\bsuperstar\b/i, category: "Superstar" },
  { test: /\bstan\s+smith\b/i, category: "Stan Smith" },
  { test: /\bspezial\b/i, category: "Spezial" },

  // New Balance: the model IS the number ("New Balance 550", "NB 1906R")
  { test: /\bnew\s+balance\s+(\d{3,4}\w{0,2})\b/i, category: "New Balance", secondary: 1 },
  { test: /\bnew\s+balance\b/i, category: "New Balance" },

  // Other brands where the brand is the useful bucket
  { test: /\buggs?\b/i, category: "UGG" },
  { test: /\bcrocs\b/i, category: "Crocs" },
  { test: /\bbirkenstock\b/i, category: "Birkenstock" },
  { test: /\bsalomon\b/i, category: "Salomon" },
  { test: /\basics\b/i, category: "ASICS" },
  { test: /\bconverse\b|\bchuck\s+taylor\b/i, category: "Converse" },
  { test: /\bvans\b|\bold\s+skool\b/i, category: "Vans" },
  { test: /\btimberland\b/i, category: "Timberland" },
  { test: /\bdr\.?\s*martens\b/i, category: "Dr. Martens" },
  { test: /\bpuma\b/i, category: "Puma" },
  { test: /\breebok\b/i, category: "Reebok" },
  { test: /\bon\s+cloud\w*\b/i, category: "On" },
  { test: /\bhoka\b/i, category: "Hoka" },
];

/** Size-run suffixes the trade puts in titles → the KicksDB gender values. */
const GENDER_TOKENS: [RegExp, string][] = [
  [/\(women'?s?\)|\bwmns\b|\(w\)$/i, "women"],
  [/\(gs\)/i, "youth"],
  [/\(ps\)|\(little\s+kids?\)/i, "preschool"],
  [/\(td\)|\(toddler\)/i, "toddler"],
  [/\(infant\)|\(i\)$/i, "infant"],
  [/\(kids?\)/i, "child"],
];

function titleGender(title: string): string {
  for (const [re, gender] of GENDER_TOKENS) {
    if (re.test(title)) return gender;
  }
  return "";
}

/**
 * Derive navigation metadata from a product title (brand as a hint only —
 * feeds often leave it empty or generic). Returns null when nothing matches,
 * so the caller keeps whatever it had.
 */
export function classifyTitle(title: string, brand = ""): DerivedMeta | null {
  const text = title.trim();
  if (!text) return null;

  for (const rule of LINES) {
    const m = text.match(rule.test);
    if (!m) continue;
    let secondary =
      typeof rule.secondary === "number" ? (m[rule.secondary] ?? "") : (rule.secondary ?? "");
    if (rule.category === "Air Jordan" && JORDAN_MODELS[secondary]) {
      secondary = JORDAN_MODELS[secondary];
    }
    return {
      category: rule.category,
      secondaryCategory: secondary,
      gender: titleGender(text),
    };
  }

  // No line matched: a known brand still beats "Senza categoria".
  const b = brand.trim();
  if (b) return { category: b, secondaryCategory: "", gender: titleGender(text) };
  return null;
}
