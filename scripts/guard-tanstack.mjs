#!/usr/bin/env node
/**
 * Supply-chain guard: fail the build if any @tanstack/* package sneaks into
 * package.json or the lockfile. See the build constraints — TanStack is banned;
 * we use RSC + Server Actions + swr instead of react-query, and a hand-rolled
 * table instead of react-table.
 */
import { readFileSync } from "node:fs";

const NEEDLE = "@tanstack";
const files = ["package.json", "package-lock.json"];
const offenders = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  } catch {
    continue; // lockfile may not exist before first install
  }
  if (text.includes(NEEDLE)) {
    const lines = text
      .split("\n")
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(({ line }) => line.includes(NEEDLE))
      .slice(0, 20);
    for (const { line, i } of lines) {
      offenders.push(`${file}:${i}: ${line.trim()}`);
    }
  }
}

if (offenders.length > 0) {
  console.error("✖ Banned dependency detected: @tanstack/* is not allowed.\n");
  for (const o of offenders) console.error("  " + o);
  console.error("\nUse RSC + Server Actions + swr, and a hand-rolled table on shadcn primitives.");
  process.exit(1);
}

console.log("✓ No @tanstack/* dependency found.");
