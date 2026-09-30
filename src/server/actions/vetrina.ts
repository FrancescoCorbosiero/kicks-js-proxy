"use server";

import { z } from "zod";
import { RAIL_FALLBACKS } from "@/config/schema";
import {
  attempt,
  publishRail,
  readCards,
  readHistory,
  readRail,
  type VetrinaResult,
  type VetrinaRail,
} from "@/server/vetrina/service";
import type { ProductCard, RailHistoryState, RailWriteResult } from "@/lib/vetrina/types";

/**
 * The Vetrina editor's server actions: thin, validated wrappers over
 * server/vetrina/service.ts. Every one answers { ok, data } or
 * { ok: false, code, error } — the editor turns the code into a message.
 */

const Key = z.string().min(3).max(300);
const Fallback = z.enum(RAIL_FALLBACKS);
const Ids = z.array(z.number().int().positive()).max(100);

export async function loadVetrinaRail(input: { key: string; fallback?: string }): Promise<VetrinaResult<VetrinaRail>> {
  const parsed = z.object({ key: Key, fallback: Fallback.optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", error: "Sezione non valida." };
  return attempt(() => readRail(parsed.data.key, parsed.data.fallback));
}

export async function loadVetrinaCards(input: {
  ids: number[];
}): Promise<VetrinaResult<{ cards: ProductCard[]; locks: Record<string, number> }>> {
  const parsed = z.object({ ids: Ids }).safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", error: "Prodotti non validi." };
  return attempt(() => readCards(parsed.data.ids));
}

export async function loadVetrinaHistory(input: { key: string }): Promise<VetrinaResult<RailHistoryState[]>> {
  const parsed = z.object({ key: Key }).safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", error: "Sezione non valida." };
  return attempt(() => readHistory(parsed.data.key));
}

const PublishSchema = z.object({
  key: Key,
  expectedModifiedGmt: z.string().min(1).max(40),
  expectedAttrsHash: z.string().min(1).max(64),
  pin: Ids,
  exclude: Ids,
  fallback: Fallback,
});

export async function publishVetrinaRail(input: z.infer<typeof PublishSchema>): Promise<VetrinaResult<RailWriteResult>> {
  const parsed = PublishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Dati non validi." };
  return attempt(() => publishRail(parsed.data));
}
