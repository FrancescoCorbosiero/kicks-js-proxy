import type { SourceSize } from "@core/core-spine";

const EU_RE = /(^|[^a-z])eu([^a-z]|$)/i; // matches "eu", "EU", "eu m", "euro"

/** The EU size from a variant's conversions, or null if none is present. */
export function euSize(sizes?: SourceSize[]): string | null {
  if (!sizes || sizes.length === 0) return null;
  const eu = sizes.find((s) => EU_RE.test(s.system) || s.system === "euro");
  return eu ? eu.size : null;
}
