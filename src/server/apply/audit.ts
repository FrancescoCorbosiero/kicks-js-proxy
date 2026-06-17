import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyAudit } from "@/server/db/schema";
import type { ApplyResult } from "@core/core-spine";

type Status = "queued" | "running" | "dry_run" | "applied" | "partial" | "failed";

/** Open an audit row for an apply attempt; returns its id. Best-effort. */
export async function startAudit(jobId: string, dryRun: boolean): Promise<string | null> {
  try {
    const [row] = await db
      .insert(applyAudit)
      .values({ jobId, dryRun, status: "running" })
      .returning({ id: applyAudit.id });
    return row.id;
  } catch (e) {
    console.warn("[audit] start skipped:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Close an audit row with the final outcome. Best-effort. */
export async function finishAudit(
  id: string | null,
  status: Status,
  updatedCount: number,
  failed: ApplyResult["failed"],
  result: Record<string, unknown>,
): Promise<void> {
  if (!id) return;
  try {
    await db
      .update(applyAudit)
      .set({ status, updatedCount, failed, result, finishedAt: new Date() })
      .where(eq(applyAudit.id, id));
  } catch (e) {
    console.warn("[audit] finish skipped:", e instanceof Error ? e.message : String(e));
  }
}
