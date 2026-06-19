import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/IO deps external to the server bundle.
  serverExternalPackages: ["ioredis", "pg"],
};

export default nextConfig;
