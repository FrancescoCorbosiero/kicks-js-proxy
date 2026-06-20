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
};

export default nextConfig;
