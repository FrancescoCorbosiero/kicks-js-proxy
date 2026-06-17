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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function snapshotInfo(): Promise<SnapshotInfo | null> {
  return getSnapshotInfo();
}
