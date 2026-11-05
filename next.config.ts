import type { NextConfig } from "next";

// NEXT_PUBLIC_BASE_PATH ("/redesign" on the shared host) mounts the whole app under a prefix. Unset, it runs at the root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    optimizePackageImports: ["recharts"],
  },
};

export default nextConfig;
