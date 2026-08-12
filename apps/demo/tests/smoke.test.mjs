import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const pageSource = await readFile(new URL("../src/routes/page.tsx", import.meta.url), "utf8");
const layoutSource = await readFile(new URL("../src/routes/layout.tsx", import.meta.url), "utf8");
const configSource = await readFile(new URL("../modern.config.ts", import.meta.url), "utf8");

test("demo app exposes standard lifecycle scripts", () => {
  assert.equal(packageJson.scripts.dev, "modern dev");
  assert.equal(packageJson.scripts.build, "modern build");
  assert.equal(packageJson.scripts["build:github-pages"], "modern build");
  assert.equal(packageJson.scripts["deploy:github-pages"], "pnpm --workspace-root run build:pages");
  assert.equal(packageJson.scripts.typecheck, "tsc --noEmit");
});

test("demo app has visible hello-world content and Modern.js app tools configured", () => {
  assert.match(pageSource, /Hello from the demo app/);
  assert.match(layoutSource, /Outlet/);
  assert.match(configSource, /appTools\(\)/);
});

test("demo app config supports repository-scoped GitHub Pages paths", () => {
  assert.match(configSource, /GITHUB_PAGES_BASE_PATH/);
  assert.match(configSource, /GITHUB_REPOSITORY/);
  assert.match(configSource, /assetPrefix: githubPagesBasePath/);
  assert.match(configSource, /server: { port: devServerPort }/);
  assert.match(configSource, /outputStructure: "flat"/);
  assert.match(configSource, /html: ""/);
});
