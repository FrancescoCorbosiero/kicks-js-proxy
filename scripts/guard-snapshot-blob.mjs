#!/usr/bin/env node
/**
 * Memory guard: the hot write paths must not read or rewrite the WHOLE store
 * snapshot.
 *
 * The snapshot is one jsonb row holding every product — 140 MB of JSON on a
 * 20 000-product shop, several times that as a live object graph. Publish,
 * rebuild and apply each used to read all of it in to change a handful of
 * products, then hand it all back to be re-serialized. The Publish tab sends
 * one call per batch, back to back, so that is ~280 MB of churn per batch; next
 * to a dev server's own footprint it exhausted the heap and killed the process
 * with "Ineffective mark-compacts near heap limit", mid-publish.
 *
 * They ask Postgres for the products they need and patch those in place now
 * (getSnapshotProductsBySkus / upsertSnapshotProducts). This guard exists
 * because the old shape is the natural one to write — it reads perfectly well
 * and only falls over at a size no test fixture has.
 *
 * Paths that legitimately need the whole model (a file upload, a duplicate
 * scan, an export, the pull that builds it) are listed below.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Whole-snapshot reads/writes are the point in these — not a leak. */
const ALLOWED = new Set([
  "server/store-json/repo.ts", // the accessors themselves
  "server/actions/store-edit.ts", // uploads and edits a whole file
  "server/actions/duplicates.ts", // scans every product by definition
  "server/actions/export.ts", // serializes the store on purpose
  "server/actions/debug.ts", // diagnostics, run by hand
  "server/woo/pull.ts", // builds the snapshot
  "server/woo/repair.ts", // walks the whole store to find gaps
  "components/catalog/drawer-data.ts", // one product, read path, not a write loop
  "app/duplicates/page.tsx",
  "server/actions/store.ts", // the file upload: the whole model IS the payload
  // These two READ the whole store and genuinely need to — a whole-store
  // preview matches every product, and the size cleanup plans over every
  // previewed one. Neither writes it back any more, which was the other half
  // of the cost. Bounding the read means paging the snapshot out of one jsonb
  // row, which is a schema change, not a patch.
  "server/actions/preview.ts",
  "server/woo/apply.ts",
]);

const BANNED = ["getActiveSnapshot", "saveSnapshot"];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) yield full;
  }
}

const offenders = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split("\\").join("/");
  if (ALLOWED.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
    for (const needle of BANNED) {
      if (line.includes(needle)) offenders.push(`src/${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error("✖ Whole-snapshot access outside the paths that need it:\n");
  for (const o of offenders) console.error("  " + o);
  console.error(
    "\nThe snapshot is one jsonb row holding the entire store. Reading it to change\n" +
      "a few products, or writing it back to save them, costs hundreds of megabytes\n" +
      "per call and is what ran the dev server out of heap mid-publish.\n\n" +
      "Use getSnapshotProductsBySkus() to read the products you need and\n" +
      "upsertSnapshotProducts() to patch them — Postgres does the swap.\n" +
      "If this path genuinely needs the whole model, add it to ALLOWED here and\n" +
      "say why.",
  );
  process.exit(1);
}

console.log("✓ No whole-snapshot reads or writes in the hot paths.");
