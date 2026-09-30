"use client";

import * as React from "react";
import type { ReactNode } from "react";
import { App } from "konsta/react";
import { Toaster } from "sonner";
import { SheetMountContext } from "./sheet-mount";

/**
 * The Vetrina's app shell: a Konsta App filling the whole screen (the phone's
 * safe areas included), above the Hub's page backdrop, plus the toasts that
 * carry "Annulla" after every move. On a desktop it is a phone-width column in
 * the middle of the screen, and everything that floats (sheets, dialogs,
 * action sheets, toasts) opens inside that column.
 */
export function VetrinaApp({ theme, children }: { theme: "ios" | "material"; children: ReactNode }) {
  const [mount, setMount] = React.useState<HTMLDivElement | null>(null);
  return (
    <div className="vetrina-backdrop fixed inset-0 z-0 overflow-hidden">
      <div className="vetrina-frame relative mx-auto h-full w-full">
        <SheetMountContext.Provider value={mount}>
          <App theme={theme} safeAreas className="!min-h-0">
            {children}
            <div ref={setMount} />
          </App>
        </SheetMountContext.Provider>
        <Toaster
          position="top-center"
          offset={{ top: "calc(env(safe-area-inset-top) + 10px)" }}
          mobileOffset={{ top: "calc(env(safe-area-inset-top) + 10px)" }}
          toastOptions={{ className: "!rounded-2xl !text-[15px]" }}
          visibleToasts={2}
        />
      </div>
    </div>
  );
}
