"use client";

import type { ReactNode } from "react";
import { App } from "konsta/react";
import { Toaster } from "sonner";

/**
 * The Vetrina's app shell: a Konsta App filling the whole screen (the phone's
 * safe areas included), above the Hub's page backdrop, plus the toasts that
 * carry "Annulla" after every move.
 */
export function VetrinaApp({ theme, children }: { theme: "ios" | "material"; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden">
      <App theme={theme} safeAreas className="!min-h-0">
        {children}
      </App>
      <Toaster
        position="top-center"
        offset={{ top: "calc(env(safe-area-inset-top) + 10px)" }}
        mobileOffset={{ top: "calc(env(safe-area-inset-top) + 10px)" }}
        toastOptions={{ className: "!rounded-2xl !text-[15px]" }}
        visibleToasts={2}
      />
    </div>
  );
}
