import type { ProductCard } from "@/lib/vetrina/types";

const euro = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

export function formatEuro(value: number | null | undefined): string {
  return value == null ? "—" : euro.format(value);
}

/** "129,99 €", or "129,99 € – 169,99 €" for a product with sizes at different prices. */
export function formatCardPrice(card: Pick<ProductCard, "price" | "priceMax">): string {
  if (card.price == null) return "—";
  if (card.priceMax != null && card.priceMax > card.price) {
    return `${euro.format(card.price)} – ${euro.format(card.priceMax)}`;
  }
  return euro.format(card.price);
}

/** "30 set, 14:05" from WordPress's GMT "2026-09-30 12:05:00". */
export function formatWhen(gmt: string, locale: string): string {
  const date = new Date(`${gmt.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return gmt;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "it-IT", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Parse a price typed on a phone: "129,99", "129.99", " 129 ". */
export function parsePrice(input: string): number | null {
  const text = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The list's short form: "da 129,99 €" when sizes differ in price. */
export function formatFromPrice(card: Pick<ProductCard, "price" | "priceMax">, fromWord: string): string {
  if (card.price == null) return "—";
  return card.priceMax != null && card.priceMax > card.price
    ? `${fromWord} ${euro.format(card.price)}`
    : euro.format(card.price);
}
