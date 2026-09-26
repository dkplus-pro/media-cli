import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPluginDirs } from "../../src/plugins/discover.js";

function makePluginDir(container: string, name: string): string {
  const dir = path.join(container, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "index.mjs"),
    `export default { name: "${name}", version: "0.1.0", commands: [] };\n`,
  );
  return dir;
}

describe("discoverPluginDirs", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "discover-"));
    roots.push(root);
    return root;
  }

  const NOPE = (base: string) => path.join(base, "does-not-exist");

  it("env 源：冒号分隔，每项是单个插件目录，按 cwd 解析", () => {
    const root = tempRoot();
    const a = makePluginDir(root, "a");
    makePluginDir(root, "b");
    const cwd = path.join(root, "cwd");
    mkdirSync(cwd, { recursive: true });

    const candidates = discoverPluginDirs(
      cwd,
      { MEDIA_CLI_PLUGINS_DIR: `a:${path.join(root, "b")}` },
      { globalRoot: NOPE(root), bundledRoot: NOPE(root) },
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({ dir: path.resolve(cwd, "a"), source: "env" });
    expect(candidates[1]).toEqual({ dir: path.join(root, "b"), source: "env" });
    expect(a).toBeTruthy();
  });

  it("project 源：cwd/plugins 容器目录，一级子目录为插件", () => {
    const cwd = tempRoot();
    makePluginDir(path.join(cwd, "plugins"), "p1");
    makePluginDir(path.join(cwd, "plugins"), "p2");

    const candidates = discoverPluginDirs(
      cwd,
      {},
      { globalRoot: NOPE(cwd), bundledRoot: NOPE(cwd) },
    );
    const sources = new Set(candidates.map((c) => c.source));
    expect(candidates.filter((c) => c.source === "project")).toHaveLength(2);
    expect(sources.has("project")).toBe(true);
  });

  it("四源顺序：env → project → global → bundled", () => {
    const root = tempRoot();
    const cwd = path.join(root, "cwd");
    const projectContainer = path.join(cwd, "plugins");
    const globalContainer = path.join(root, "global-plugins");
    const bundledContainer = path.join(root, "bundled-plugins");
    mkdirSync(cwd, { recursive: true });
    makePluginDir(projectContainer, "p");
    makePluginDir(globalContainer, "g");
    makePluginDir(bundledContainer, "b");

    const candidates = discoverPluginDirs(
      cwd,
      {},
      { globalRoot: globalContainer, bundledRoot: bundledContainer },
    );

    expect(candidates.map((c) => c.source)).toEqual(["project", "global", "bundled"]);
    expect(candidates.map((c) => c.dir.split(path.sep).pop())).toEqual(["p", "g", "b"]);
  });

  it("bundled 与 project 同目录时跳过（开发态去重）", () => {
    const cwd = tempRoot();
    makePluginDir(path.join(cwd, "plugins"), "p");

    const candidates = discoverPluginDirs(cwd, {}, { bundledRoot: path.join(cwd, "plugins") });

    expect(candidates.filter((c) => c.source === "bundled")).toHaveLength(0);
  });

  it("不存在的目录静默跳过，不抛错", () => {
    const cwd = tempRoot();
    const candidates = discoverPluginDirs(
      cwd,
      {},
      {
        globalRoot: path.join(cwd, "nope"),
        bundledRoot: path.join(cwd, "also-nope"),
      },
    );
    expect(candidates).toEqual([]);
  });
});
