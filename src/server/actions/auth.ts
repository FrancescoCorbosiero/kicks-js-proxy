"use server";

import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, sessionToken } from "@/lib/auth";
import { getServerDictionary } from "@/i18n/server";

/**
 * Login/logout for the shared-password gate (see src/middleware.ts). The
 * password is checked in constant time; success sets the signed session
 * cookie the middleware verifies on every request.
 */

export interface LoginState {
  error: string | null;
}

function passwordMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  // timingSafeEqual requires equal lengths; compare against self to keep the
  // work constant-shaped before rejecting on length.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const { t } = await getServerDictionary();
  const expected = env.APP_PASSWORD;
  if (!expected) redirect("/"); // auth disabled — nothing to log into

  const candidate = String(formData.get("password") ?? "");
  if (!candidate || !passwordMatches(candidate, expected)) {
    return { error: t.login.wrong };
  }

  const store = await cookies();
  store.set(AUTH_COOKIE, await sessionToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE,
  });

  const from = String(formData.get("from") ?? "");
  redirect(from.startsWith("/") && !from.startsWith("//") ? from : "/");
}

export async function logout(): Promise<void> {
  const store = await cookies();
  store.delete(AUTH_COOKIE);
  redirect("/login");
}
