import { defineConfig, type Options } from "tsup";
import pkg from "./package.json" with { type: "json" };

// Kept by the minifier (it starts with /*!), so the copyright notice the MIT
// licence requires travels with every copy of the built code.
const notice = `/*! pondscape v${pkg.version} | MIT License | (c) Suraj Pathak | https://github.com/surajpathakcs/pondscape */`;

const shared: Options = {
  format: ["esm"],
  target: "es2020",
  dts: true,
  sourcemap: true,
  minify: true,
  banner: { js: notice },
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
  },
  {
    // The React component is its own entry, with its "use client" line. It
    // imports the core from the published package rather than bundling a
    // second copy of it.
    ...shared,
    entry: { react: "src/react.tsx" },
    external: ["react", "pondscape"],
    esbuildPlugins: [
      {
        name: "core-from-package",
        setup(build) {
          build.onResolve({ filter: /^\.\/pond$/ }, () => ({ path: "pondscape", external: true }));
        },
      },
    ],
  },
]);
