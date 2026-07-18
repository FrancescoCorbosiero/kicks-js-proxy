"use server";

import { parseStoreModel } from "@/server/store-json/model";
import { saveSnapshot, getSnapshotInfo, type SnapshotInfo } from "@/server/store-json/repo";

export interface UploadResult {
  ok: boolean;
  error?: string;
  info?: SnapshotInfo;
}

/** Validate + persist the uploaded WooCommerce round-trip JSON as the snapshot. */
export async function uploadStoreSnapshot(text: string): Promise<UploadResult> {
  try {
    const model = parseStoreModel(text);
    await saveSnapshot(model);
    const info = await getSnapshotInfo();
    return { ok: true, info: info ?? undefined };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

/** Surface the real Postgres cause (drizzle wraps it) and hint at the fix. */
function describeError(e: unknown): string {
  const cause = (e as { cause?: { message?: string; code?: string } })?.cause;
  const code = cause?.code;
  const message = cause?.message ?? (e instanceof Error ? e.message : String(e));
  // 42P01 = undefined_table -> migrations not applied yet.
  if (code === "42P01" || /relation .* does not exist/i.test(message)) {
    return "Database not migrated: the store_snapshot table is missing. Run `npm run db:migrate`, then retry.";
  }
  return message;
}
