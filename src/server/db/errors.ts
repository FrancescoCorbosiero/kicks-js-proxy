import "server-only";

/**
 * Classify a thrown DB error into the two failure modes an operator can fix
 * themselves, so pages can render a remedy instead of a crash overlay:
 *
 *  - "unreachable": Postgres isn't accepting connections (Docker not up,
 *    wrong DATABASE_URL). Node surfaces this as an AggregateError
 *    (ECONNREFUSED on every resolved address) with no useful message.
 *  - "unmigrated": the DB answers but a table is missing (42P01 /
 *    "relation … does not exist") — migrations not applied.
 */
export type DbFailureKind = "unreachable" | "unmigrated" | "unknown";

export interface DbFailure {
  kind: DbFailureKind;
  message: string;
}

export function classifyDbError(e: unknown): DbFailure {
  let message = e instanceof Error ? e.message : String(e);
  let kind: DbFailureKind = "unknown";

  // Drizzle wraps the pg error; pg may wrap the net error. Walk the chain.
  let current: unknown = e;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    const err = current as { code?: string; message?: string; cause?: unknown };
    if (err.message) message = err.message;

    const code = err.code ?? "";
    if (
      current instanceof AggregateError ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET"
    ) {
      kind = "unreachable";
      break;
    }
    if (code === "42P01" || /relation .* does not exist/i.test(err.message ?? "")) {
      kind = "unmigrated";
      break;
    }
    current = err.cause;
  }

  return { kind, message };
}
