import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The container's health check (HEALTHCHECK in the Dockerfile): the server is
 * up and answering. Docker calls it on 127.0.0.1, not through Caddy, so
 * src/proxy.ts lets it in without the sign-in headers — which is why it
 * answers nothing but "ok".
 */
export function GET() {
  return NextResponse.json({ ok: true });
}
