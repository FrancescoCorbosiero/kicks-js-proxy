import "server-only";
import { env } from "@/lib/env";
import { hubConfig } from "@/config";
import type {
  Capabilities,
  Homepage,
  ProductCard,
  RailDetail,
  RailFallback,
  RailHistoryState,
  RailWrite,
  RailWriteResult,
  VetrinaErrorCode,
} from "@/lib/vetrina/types";

/**
 * Where the Vetrina reads and writes the homepage. Two implementations with
 * one contract: the live site (golden-hive-blocks' wc-gh/v1) and an in-memory
 * demo shop that behaves the same way, for trying the editor without a site.
 */
export interface VetrinaSource {
  readonly kind: "wordpress" | "fixture";
  capabilities(): Promise<Capabilities>;
  homepage(): Promise<Homepage>;
  /** A rail by its stable key ("category:saldi-sneakers-outlet#0"), every member included. */
  rail(key: string, opts?: { offset?: number; count?: number; fallback?: RailFallback }): Promise<RailDetail>;
  products(ids: number[]): Promise<ProductCard[]>;
  writeRail(input: RailWrite): Promise<RailWriteResult>;
  history(key: string): Promise<RailHistoryState[]>;
}

/** A failure the Vetrina explains in its own words (see VetrinaErrorCode). */
export class VetrinaError extends Error {
  constructor(
    readonly code: VetrinaErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VetrinaError";
  }
}

/** The configured source; VETRINA_SOURCE overrides hub.config.ts. */
export async function getVetrinaSource(): Promise<VetrinaSource> {
  const kind = env.VETRINA_SOURCE ?? hubConfig.vetrina.source;
  if (kind === "fixture") {
    const { fixtureSource } = await import("./fixture-source");
    return fixtureSource();
  }
  const { wordpressSource } = await import("./wp-source");
  return wordpressSource();
}
