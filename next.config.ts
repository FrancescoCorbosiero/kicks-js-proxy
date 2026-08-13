import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/IO deps external to the server bundle.
  serverExternalPackages: ["ioredis", "pg"],
  experimental: {
    serverActions: {
      // Store snapshots (the uploaded WooCommerce round-trip JSON) and the
      // repriced export can be many MB; Next caps Server Action bodies at 1 MB
      // by default, which rejected large uploads. Lift it well above the
      // largest real exports (~20 MB) so big catalogs go through.
      bodySizeLimit: "50mb",
    },
  },
  /**
   * The margins admin is called "Margini" everywhere in the UI but lives at
   * /pricing, so typing the tab's own name into the address bar 404s. Point
   * the names the page actually goes by at the real route instead — /pricing
   * stays canonical, so every existing link and bookmark keeps working.
   */
  async redirects() {
    return ["/margins", "/margini", "/markup", "/markups", "/ricarichi"].map((source) => ({
      source,
      destination: "/pricing",
      permanent: false,
    }));
  },
};

export default nextConfig;
