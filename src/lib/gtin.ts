/**
 * GTIN hygiene — the identifier every external catalog (Google Merchant
 * Center, TikTok Shop, Meta) keys a product on.
 *
 * Suppliers ship barcodes the way their export tool left them: padded, spaced,
 * with an Excel apostrophe, as a 12-digit UPC-A, occasionally mistyped. A
 * channel does not negotiate — a bad check digit disapproves the offer, and a
 * GTIN repeated across two offers disapproves BOTH. Since a product with no
 * GTIN can still be listed on brand + MPN, a barcode we cannot vouch for is
 * worth less than none at all: this module drops it and says why, instead of
 * passing corruption downstream where only the channel will notice.
 *
 * Pure module — no DB, no HTTP.
 */

/** Why a raw barcode was refused. Codes, not sentences: the UI translates. */
export type GtinRejection = "empty" | "nonNumeric" | "badLength" | "badCheckDigit";

export interface GtinResult {
  /** The canonical value to write, or null when nothing can be trusted. */
  gtin: string | null;
  rejection: GtinRejection | null;
}

/** Standard GS1 mod-10: weights alternate 3/1 from the RIGHT, before the check digit. */
function checkDigitOk(digits: string): boolean {
  let sum = 0;
  // Walk right-to-left over the payload (everything but the last digit).
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(digits[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * Clean and validate one barcode.
 *
 * A UPC-A (12) is zero-padded to a GTIN-13: the check digit is unchanged by
 * the pad (the alternating weights land on the same digits), and European
 * channels expect 13, so this is a normalization and never a rewrite.
 */
export function normalizeGtin(raw: unknown): GtinResult {
  if (raw == null) return { gtin: null, rejection: "empty" };
  // Excel exports quote long numbers; feeds add spaces, dots and dashes.
  const cleaned = String(raw).trim().replace(/^'/, "").replace(/[\s.\-_]/g, "");
  if (cleaned === "") return { gtin: null, rejection: "empty" };
  if (!/^\d+$/.test(cleaned)) return { gtin: null, rejection: "nonNumeric" };
  // Leading zeros beyond a canonical width are padding from a fixed-width
  // column, not part of the number.
  const trimmed = cleaned.length > 14 ? cleaned.replace(/^0+/, "") : cleaned;
  if (![8, 12, 13, 14].includes(trimmed.length)) return { gtin: null, rejection: "badLength" };
  if (!checkDigitOk(trimmed)) return { gtin: null, rejection: "badCheckDigit" };
  return { gtin: trimmed.length === 12 ? `0${trimmed}` : trimmed, rejection: null };
}

/** Convenience: the value alone, null when unusable. */
export function toGtin(raw: unknown): string | null {
  return normalizeGtin(raw).gtin;
}

/**
 * Find GTINs claimed by more than one size of the same product. Each size of a
 * shoe carries its own barcode; a repeat is a supplier data error, and since
 * there is no way to tell which size the number really belongs to, EVERY
 * claimant loses it — one wrong offer is worse than two identifier-less ones.
 */
export function duplicateGtins(values: (string | null | undefined)[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return dupes;
}
