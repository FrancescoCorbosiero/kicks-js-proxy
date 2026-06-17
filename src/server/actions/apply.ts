"use server";

import { z } from "zod";
import { enqueueApply, getApplyStatus } from "@/server/queue/apply";
import type { ApplyJobStatus } from "@/server/apply/types";

const ApplyInputSchema = z.object({
  selections: z
    .array(
      z.object({
        planId: z.string().min(1),
        variantIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  dryRun: z.boolean(),
  approved: z.boolean(),
});

export type ApplyInput = z.infer<typeof ApplyInputSchema>;

export async function startApply(
  input: ApplyInput,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const parsed = ApplyInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    const jobId = await enqueueApply(parsed.data);
    return { ok: true, jobId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyStatus(jobId: string): Promise<ApplyJobStatus> {
  return getApplyStatus(jobId);
}
