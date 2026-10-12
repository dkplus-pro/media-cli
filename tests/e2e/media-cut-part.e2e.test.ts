import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: merged,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

interface CliEnveloped {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: unknown[];
}

// node 自身可执行：用作「引擎已就绪但不会被调用」的占位 bin，避免错误分支触发 swiftc 编译
const FAKE_BIN = process.execPath;
const PARTS = ["head", "hat", "top", "bottom", "outfit", "gloves", "shoes", "socks"];

describe("media-cut-part 错误分支（无需 macOS 集成环境）", () => {
  it("缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-cut-part"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("缺 --part → E_MISSING_ARGUMENT", async () => {
    const r = await cli(["--json", "media-cut-part", "--input", "x.png"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_ARGUMENT");
    expect(parsed.error?.details).toMatchObject({ option: "--part" });
  });

  it("--part 不在白名单 → E_INVALID_OPTION 并列出 allowed", async () => {
    const r = await cli(["--json", "media-cut-part", "--input", "x.png", "--part", "dress"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_INVALID_OPTION");
    expect(parsed.error?.details).toMatchObject({ option: "--part", value: "dress" });
    expect(parsed.error?.details?.allowed).toEqual(PARTS);
  });

  it("--padding 非法 → E_INVALID_OPTION", async () => {
    const r = await cli([
      "--json",
      "media-cut-part",
      "--input",
      "x.png",
      "--part",
      "top",
      "--padding",
      "-1",
    ]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("PART_CROP_BIN 不可执行 → E_MISSING_DEPENDENCY 退出 3", async () => {
    const r = await cli(["--json", "media-cut-part", "--input", "x.png", "--part", "top"], {
      PART_CROP_BIN: "/nonexistent",
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_DEPENDENCY");
    expect(parsed.error?.details).toMatchObject({
      dependency: "vision-part-crop",
      envVar: "PART_CROP_BIN",
    });
  });

  it("输入不存在 → E_MISSING_ARGUMENT", async () => {
    const r = await cli(
      ["--json", "media-cut-part", "--input", "/nonexistent.png", "--part", "top"],
      {
        PART_CROP_BIN: FAKE_BIN,
      },
    );
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("目录内无可处理图片 → E_INVALID_OPTION", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "media-cut-part-empty-"));
    try {
      await writeFile(path.join(dir, "note.txt"), "no image here");
      const r = await cli(["--json", "media-cut-part", "--input", dir, "--part", "top"], {
        PART_CROP_BIN: FAKE_BIN,
      });
      expect(r.code).toBe(2);
      expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("spec 自省含 media-cut-part 且 source 为 plugin:media-cutout", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const cmd = parsed.data.commands.find((c) => c.name === "media-cut-part");
    expect(cmd?.source).toBe("plugin:media-cutout");
  });
});

// 部位裁剪依赖真人照片（人像分割 + 姿态关键点），合成图形无法触发 Vision 人体检测，
// 因此集成分支需显式提供照片：MEDIA_CUT_PART_PHOTO=<含完整人体的图片路径>
const photo = process.env.MEDIA_CUT_PART_PHOTO;
const hasSwiftc = (() => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      execFileSync("test", ["-x", path.join(dir, "swiftc")], { stdio: "ignore" });
      return true;
    } catch {
      // 下一个
    }
  }
  return false;
})();
const canIntegrate =
  process.platform === "darwin" && hasSwiftc && Boolean(photo) && existsSync(photo as string);

describe.skipIf(!canIntegrate)("media-cut-part 集成（macOS Vision，需真人照片）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-cut-part-e2e-"));
    execFileSync("cp", [photo as string, path.join(dir, "person.jpg")]);
    // 批量输入单独放子目录：避免上一个用例的输出图被当成待处理图片
    await mkdir(path.join(dir, "batch"), { recursive: true });
    execFileSync("cp", [photo as string, path.join(dir, "batch", "person.jpg")]);
    await writeFile(path.join(dir, "batch", "broken.png"), "not an image");
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("单文件：裁出上半身衣服区域，输出透明 PNG", async () => {
    const out = path.join(dir, "top.png");
    const r = await cli([
      "--json",
      "media-cut-part",
      "--input",
      path.join(dir, "person.jpg"),
      "--output",
      out,
      "--part",
      "top",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { path: string; part: string; width: number; height: number; padding: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.part).toBe("top");
    expect(parsed.data.padding).toBe(0);
    expect(parsed.data.width).toBeGreaterThan(0);
    expect(parsed.data.height).toBeGreaterThan(0);
    expect(await readFile(out).then((b) => b.subarray(1, 4).toString("ascii"))).toBe("PNG");
  }, 120_000);

  it("文件夹批量：坏图进 failed，其余成功", async () => {
    const r = await cli([
      "--json",
      "media-cut-part",
      "--input",
      path.join(dir, "batch"),
      "--part",
      "shoes",
      "--output",
      path.join(dir, "out"),
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { part: string; results: unknown[]; failed: { file: string }[]; total: number };
    };
    expect(parsed.data.part).toBe("shoes");
    expect(parsed.data.total).toBe(2);
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.failed).toHaveLength(1);
    expect(parsed.data.failed[0].file).toContain("broken.png");
    expect(existsSync(path.join(dir, "out", "person.png"))).toBe(true);
  }, 180_000);
});
