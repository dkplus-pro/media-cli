import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin/common-cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
});
