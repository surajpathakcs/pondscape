import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Use the library's source rather than its built dist/, so edits to it
    // reload live. Matching paths in tsconfig.json give the same to types.
    resolveAlias: {
      "pondscape/react": "../../packages/pondscape/src/react.tsx",
      pondscape: "../../packages/pondscape/src/index.ts",
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
