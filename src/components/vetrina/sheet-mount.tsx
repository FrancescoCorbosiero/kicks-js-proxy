"use client";

import * as React from "react";

/**
 * Where bottom sheets mount: an element inside the Vetrina's app shell, not
 * document.body. Inside, a sheet inherits the shell's dark-mode colours and,
 * on desktop, opens within the app column instead of across the screen.
 */
export const SheetMountContext = React.createContext<Element | null>(null);

export function useSheetMount(): Element | undefined {
  return React.useContext(SheetMountContext) ?? undefined;
}

/**
 * True on the Vetrina's own address (VETRINA_HOST): links into the operator
 * Hub are hidden there, since that host does not serve it.
 */
export const StandaloneContext = React.createContext(false);

export function useStandalone(): boolean {
  return React.useContext(StandaloneContext);
}
