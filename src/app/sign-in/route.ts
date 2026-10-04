import { getServerDictionary } from "@/i18n/server";
import { env } from "@/lib/env";
import { renderSignInPage, signInPolicy } from "@/lib/sign-in-page";
import { isVetrinaHost, requestHost } from "@/lib/vetrina-host";

export const dynamic = "force-dynamic";

/**
 * The sign-in page (src/lib/sign-in-page.ts). Caddy serves it at
 * https://<address>/authelia/, where Authelia sends anyone without a session,
 * by rewriting that path to this one (deploy/docker-compose.yml). No session
 * is needed to see it: src/proxy.ts lets it through, still only via Caddy.
 */
export async function GET(req: Request) {
  const { locale, t } = await getServerDictionary();
  const host = requestHost(req.headers);
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const html = renderSignInPage({
    t: t.signIn,
    locale,
    area: isVetrinaHost(host, env.VETRINA_HOST) ? "vetrina" : "hub",
    host,
    nonce,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": signInPolicy(nonce),
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
