"use client";

import * as React from "react";
import { login, type LoginState } from "@/server/actions/auth";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The password form — client component only for the pending/error states. */
export function LoginForm({ from }: { from: string }) {
  const { t } = useI18n();
  const [state, action, pending] = React.useActionState<LoginState, FormData>(login, {
    error: null,
  });

  return (
    <form action={action} className="mt-4 space-y-3">
      <input type="hidden" name="from" value={from} />
      <Input
        type="password"
        name="password"
        autoFocus
        autoComplete="current-password"
        aria-label={t.login.password}
        placeholder={t.login.password}
      />
      {state.error && <p className="text-sm text-skip">{state.error}</p>}
      <Button type="submit" variant="accent" className="w-full" disabled={pending}>
        {pending ? (
          <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
        ) : (
          t.login.submit
        )}
      </Button>
    </form>
  );
}
