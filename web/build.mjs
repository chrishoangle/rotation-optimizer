// Builds the site into ../docs/app, which GitHub Pages serves at
// https://chrishoangle.github.io/rotation-optimizer/app/.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const out = new URL("../docs/app/", import.meta.url);
mkdirSync(out, { recursive: true });
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
await build({
  entryPoints: [new URL("./src/app.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: new URL("app.js", out).pathname,
  loader: { ".csv": "text" },
  platform: "browser",
  external: ["node:*"], // highs loads these only when it runs under Node
  define: { __VERSION__: JSON.stringify(pkg.version), __RELEASE_DATE__: JSON.stringify(process.env.RELEASE_DATE ?? "2026-10-22") },
  logLevel: "warning",
});
copyFileSync(new URL("./node_modules/highs/build/highs.wasm", import.meta.url), new URL("highs.wasm", out));
copyFileSync(new URL("./src/style.css", import.meta.url), new URL("style.css", out));
writeFileSync(new URL("index.html", out), readFileSync(new URL("./index.html", import.meta.url), "utf8"));
console.log("built docs/app");
