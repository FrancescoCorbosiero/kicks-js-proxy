import type { ApplyOutcome } from "./executor";

export interface ApplyJobData {
  selections: { planId: string; variantIds: string[] }[];
  dryRun: boolean;
  approved: boolean;
}

export type { ApplyOutcome };

export interface ApplyJobStatus {
  state: "queued" | "waiting" | "active" | "completed" | "failed" | "delayed" | "not_found" | string;
  progress: number; // 0..100
  result: ApplyOutcome | null;
  error: string | null;
}
