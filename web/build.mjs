// Builds the site into ../docs/app, which GitHub Pages serves at
// https://chrishoangle.github.io/rotation-optimizer/app/.
import { build } from "esbuild";
import { createHash } from "node:crypto";
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
  loader: { ".csv": "text", ".txt": "text" },
  platform: "browser",
  external: ["node:*"], // highs loads these only when it runs under Node
  define: { __VERSION__: JSON.stringify(pkg.version), __RELEASE_DATE__: JSON.stringify(process.env.RELEASE_DATE ?? "2026-10-22") },
  logLevel: "warning",
});
// The read-only page volunteers open from the coordinator's QR code.
await build({
  entryPoints: [new URL("./src/view.ts", import.meta.url).pathname],
  bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false,
  outfile: new URL("view.js", out).pathname, platform: "browser", logLevel: "warning",
});
writeFileSync(new URL("view.html", out), readFileSync(new URL("./view.html", import.meta.url), "utf8"));
copyFileSync(new URL("./node_modules/highs/build/highs.wasm", import.meta.url), new URL("highs.wasm", out));
copyFileSync(new URL("./src/style.css", import.meta.url), new URL("style.css", out));
writeFileSync(new URL("index.html", out), readFileSync(new URL("./index.html", import.meta.url), "utf8"));
// The service worker keeps a copy of these files on the coordinator's device,
// so the page opens with no internet after one visit. Its cache name changes
// with the files, so a new release replaces the old copy.
const files = ["./", "index.html", "app.js", "style.css", "highs.wasm", "view.html", "view.js"];
const hash = createHash("sha256");
for (const f of files.slice(1)) hash.update(readFileSync(new URL(f, out)));
writeFileSync(new URL("sw.js", out), readFileSync(new URL("./src/sw.js", import.meta.url), "utf8")
  .replace("__CACHE__", `rotation-optimizer-${pkg.version}-${hash.digest("hex").slice(0, 12)}`)
  .replace("__FILES__", JSON.stringify(files)));
console.log("built docs/app");
