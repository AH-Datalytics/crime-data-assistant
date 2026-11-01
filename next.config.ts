import type { NextConfig } from "next";

// Local NIBRS preview only (`next dev --webpack` with NIBRS_SHADOW_ROOT set): the shadow engine reads its fixtures
// relative to its own source folder (lib/nibrs-shadow/places.ts, srs.ts), which a bundle does not have. Keeping
// __dirname source-relative lets those reads resolve from the project root. A production build (`next build` sets
// NODE_ENV=production before it reads this file) and any machine without the preview build get no webpack hook at
// all, so Turbopack builds as before (scripts/test-nibrs-preview-production.sh builds with NIBRS_SHADOW_ROOT set).
const previewWebpack = process.env.NODE_ENV !== "production" && !!process.env.NIBRS_SHADOW_ROOT;

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    optimizePackageImports: ["recharts"],
  },
  ...(previewWebpack
    ? {
        webpack: (config: { node?: Record<string, unknown> }, { dev, isServer }: { dev: boolean; isServer: boolean }) => {
          if (dev && isServer) config.node = { ...config.node, __dirname: true };
          return config;
        },
      }
    : {}),
};

export default nextConfig;
