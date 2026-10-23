// Bundles the service into one file so the container image needs no node_modules.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
  // yaml ships CommonJS for Node; give the ESM bundle a require() to load it with.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
