/**
 * format.ts — display helpers. Pure, framework-agnostic.
 */

const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
};

export function money(value: number | null | undefined, currency = "EUR"): string {
  if (value == null) return "—";
  const sym = CURRENCY_SYMBOL[currency] ?? "";
  return `${sym}${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function pct(value: number | null | undefined, withSign = true): string {
  if (value == null) return "—";
  const sign = withSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function delta(current: number | null, proposed: number | null): number | null {
  if (current == null || proposed == null || current === 0) return null;
  return ((proposed - current) / current) * 100;
}

export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function compactTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
