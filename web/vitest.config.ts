import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The build imports .csv and .txt files as text (see build.mjs); tests do the same.
  plugins: [{
    name: "text-files",
    enforce: "pre",
    load(id: string) {
      if (/\.(csv|txt)$/.test(id)) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      return null;
    },
  }],
  test: { globals: true, testTimeout: 120000, hookTimeout: 60000 },
});
