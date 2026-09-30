"use client";

import { useRouter } from "next/navigation";
import { Block, Button } from "konsta/react";
import { useI18n } from "@/i18n/provider";
import type { VetrinaErrorCode } from "@/lib/vetrina/types";

/** A Vetrina failure in plain words, with the technical detail folded away. */
export function ErrorState({ code, error }: { code: VetrinaErrorCode; error: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const message = t.vetrina.errors[code] ?? t.vetrina.errors.failed;

  return (
    <Block strong inset className="space-y-4 text-center">
      <p className="text-[17px] leading-snug">{message}</p>
      <Button rounded large onClick={() => router.refresh()} className="w-full">
        {t.vetrina.errors.retry}
      </Button>
      <details className="text-left text-[13px] opacity-60">
        <summary className="cursor-pointer">{t.vetrina.errors.details}</summary>
        <p className="mt-2 whitespace-pre-wrap break-words font-mono">{error}</p>
      </details>
    </Block>
  );
}
