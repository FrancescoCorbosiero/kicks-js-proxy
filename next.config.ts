import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The apply worker uses ioredis/bullmq/pg — keep them external to the server bundle.
  serverExternalPackages: ["bullmq", "ioredis", "pg"],
};

export default nextConfig;
