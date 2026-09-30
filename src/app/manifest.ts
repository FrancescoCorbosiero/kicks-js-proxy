import type { MetadataRoute } from "next";
import { hubConfig } from "@/config";

/**
 * "Add to Home Screen": the Hub installs as a full-screen app that opens on
 * the configured landing page (the Vetrina). No service worker on purpose —
 * the Vetrina must always show the live homepage, never a cached one.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Store Hub — Vetrina",
    short_name: "Vetrina",
    description: "La homepage del negozio, sezione per sezione.",
    start_url: hubConfig.ui.landing,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f2f2f7",
    theme_color: "#f2f2f7",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
