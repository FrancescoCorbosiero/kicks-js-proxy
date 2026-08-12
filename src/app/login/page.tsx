import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { AUTH_COOKIE, sessionToken } from "@/lib/auth";
import { getServerDictionary } from "@/i18n/server";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

/**
 * The sign-in screen. Renders as a full-screen layer above the app chrome —
 * pre-auth there is nothing to navigate. Already-authenticated visits (and
 * deployments with auth disabled) bounce straight to the app.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { t } = await getServerDictionary();

  if (!env.APP_PASSWORD) redirect("/");
  const store = await cookies();
  if (store.get(AUTH_COOKIE)?.value === (await sessionToken(env.APP_PASSWORD))) {
    redirect("/");
  }

  const from = sp.from && sp.from.startsWith("/") && !sp.from.startsWith("//") ? sp.from : "/";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg px-6">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-lg font-extrabold text-accent-fg shadow-[0_4px_12px_-6px] shadow-accent/35">
            S
          </span>
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-tight">Store Hub</div>
            <div className="text-xs text-faint">{t.header.tagline}</div>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <h1 className="text-lg font-bold tracking-tight">{t.login.heading}</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted">{t.login.desc}</p>
          <LoginForm from={from} />
        </div>
      </div>
    </div>
  );
}
