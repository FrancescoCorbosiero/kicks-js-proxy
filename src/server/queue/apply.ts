import "server-only";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/lib/env";
import { processApplyJob } from "@/server/apply/job";
import type { ApplyJobData, ApplyJobStatus } from "@/server/apply/types";

const QUEUE_NAME = "apply";

/**
 * Single-deployable setup: the apply Queue AND its Worker live in the Next server
 * process, kept as globals so hot-reload / multiple route workers don't spawn
 * duplicates. BullMQ requires maxRetriesPerRequest=null on the connection.
 */
const g = globalThis as unknown as {
  __applyConn?: IORedis;
  __applyQueue?: Queue<ApplyJobData>;
  __applyWorker?: Worker<ApplyJobData>;
};

function connection(): ConnectionOptions {
  if (!g.__applyConn) {
    g.__applyConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    g.__applyConn.on("error", () => {});
  }
  // bullmq bundles its own ioredis copy; the instance is duck-compatible at
  // runtime, so bridge the nominal type mismatch here.
  return g.__applyConn as unknown as ConnectionOptions;
}

function queue(): Queue<ApplyJobData> {
  if (!g.__applyQueue) g.__applyQueue = new Queue(QUEUE_NAME, { connection: connection() });
  return g.__applyQueue;
}

function ensureWorker(): void {
  if (g.__applyWorker) return;
  g.__applyWorker = new Worker<ApplyJobData>(
    QUEUE_NAME,
    (job) => processApplyJob(job.id!, job.data, (p) => job.updateProgress(p)),
    { connection: connection(), concurrency: 1 },
  );
  g.__applyWorker.on("error", () => {});
}

export async function enqueueApply(data: ApplyJobData): Promise<string> {
  ensureWorker();
  const job = await queue().add("apply", data, {
    removeOnComplete: 200,
    removeOnFail: 200,
  });
  return job.id!;
}

export async function getApplyStatus(jobId: string): Promise<ApplyJobStatus> {
  const job = await queue().getJob(jobId);
  if (!job) return { state: "not_found", progress: 0, result: null, error: null };
  const state = await job.getState();
  const progress = typeof job.progress === "number" ? job.progress : 0;
  return {
    state,
    progress,
    result: (job.returnvalue as ApplyJobStatus["result"]) ?? null,
    error: job.failedReason ?? null,
  };
}
