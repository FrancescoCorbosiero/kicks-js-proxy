import { classifyDbError } from "@/server/db/errors";
import { getServerDictionary } from "@/i18n/server";

/**
 * Full-page notice rendered when a tab's initial server load can't reach the
 * database — with the exact remedy, instead of the Next error overlay. Server
 * component: pages `catch` their loads and return this.
 */
export async function DbUnavailable({ error }: { error: unknown }) {
  const { t } = await getServerDictionary();
  const failure = classifyDbError(error);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="rounded-xl border border-warn/30 bg-warn/5 p-6 animate-fade-up">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
              <ellipse cx="12" cy="5" rx="8" ry="3" />
              <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
            </svg>
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight">{t.dbError.title}</h1>
            <p className="text-sm text-muted">
              {failure.kind === "unreachable"
                ? t.dbError.unreachable
                : failure.kind === "unmigrated"
                  ? t.dbError.unmigrated
                  : t.dbError.unknown}
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2 text-sm">
          <p className="font-medium">{t.dbError.remedyTitle}</p>
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed">
            {failure.kind === "unmigrated"
              ? "npm run db:migrate"
              : "docker compose up -d   # local Postgres + Redis\nnpm run db:migrate"}
          </pre>
          <p className="text-xs text-muted">{t.dbError.envHint}</p>
        </div>

        <details className="mt-4 text-xs text-faint">
          <summary className="cursor-pointer font-medium text-muted">{t.dbError.details}</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono">{failure.message}</pre>
        </details>
      </div>
    </main>
  );
}
