import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type CliRun, cli } from "./helpers/cli";

// spawn 真进程的 e2e：全量并发时单条会超过 vitest 默认 5s（实测 F7 字号用例在满载下超时），
// 故整文件设 30s 上限，与仓库既有慢用例显式 `, 30000)` 的口径一致。
vi.setConfig({ testTimeout: 30_000 });

interface FaceCircle {
  x: number;
  y: number;
  r: number;
  confidence: number | null;
  source: string;
}

interface CoverData {
  path?: string;
  width?: number;
  height?: number;
  covered?: number;
  faces?: FaceCircle[];
  scale?: number;
  color?: string;
  minConfidence?: number;
  manualCircles?: number;
  outputDir?: string;
  total?: number;
  results?: { path: string; covered: number }[];
  failed?: { file: string; reason: string }[];
}

interface Envelope {
  ok: boolean;
  data: CoverData;
  warnings: { code: string; message: string; plugin?: string }[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface Run extends CliRun {
  j: Envelope;
}

const GRAY = "#808080";

let dir = "";
let gray = ""; // 200x200 无损灰图：像素断言的基准
let stubTwo = "";
let stubNone = "";

// FACE_BIN 桩：把 Apple Vision 的 stdout 契约直接喂给 Node 侧，
// 于是检测/降级/批量分支在任意平台都确定性可测（不依赖 macOS + swiftc）。
async function stub(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const say = (json: string) => `printf '%s\\n' '${json}'`;
const TWO_FACES =
  '{"width":200,"height":200,"faces":[{"x":20,"y":20,"w":60,"h":80,"confidence":0.9,"quality":null},' +
  '{"x":120,"y":100,"w":40,"h":40,"confidence":0.5,"quality":null}]}';

async function cover(args: string[], bin: string, cwd?: string): Promise<Run> {
  const r = await cli(["--json", "media-face-cover", ...args], { FACE_BIN: bin }, cwd);
  return { ...r, j: JSON.parse(r.stdout) as Envelope };
}

async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
}

const grey = (w = 200, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: GRAY } });

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(path.join(tmpdir(), "media-face-cover-e2e-")));
  gray = path.join(dir, "photo.png");
  await grey().png().toFile(gray);
  // EXIF orientation=6：Swift 的 applyOrientationProperty 与 JS 的 .rotate() 都要摆正成 100x200
  await grey(200, 100)
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toFile(path.join(dir, "rot.jpg"));
  await writeFile(path.join(dir, "clip.gif"), "GIF89a 不在扩展名白名单里");
  await mkdir(path.join(dir, "batch", "sub"), { recursive: true });
  await grey()
    .png()
    .toFile(path.join(dir, "batch", "a.png"));
  await grey()
    .png()
    .toFile(path.join(dir, "batch", "b.png"));
  await grey()
    .png()
    .toFile(path.join(dir, "batch", "sub", "c.png"));
  await writeFile(path.join(dir, "batch", "broken.png"), "not an image");
  await writeFile(path.join(dir, "batch", "note.txt"), "ignored by extension filter");
  stubTwo = await stub("stub-two", say(TWO_FACES));
  stubNone = await stub("stub-none", say('{"width":200,"height":200,"faces":[]}'));
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("media-face-cover 用法错误（退出码 2）", () => {
  it("缺 --input / 输入不存在 → E_MISSING_ARGUMENT", async () => {
    expect((await cover([], stubNone)).code).toBe(2);
    const missing = await cover(["--input", "/nonexistent.png"], stubNone);
    expect([missing.code, missing.j.error?.code]).toEqual([2, "E_MISSING_ARGUMENT"]);
  });

  it("不支持的扩展名 .gif → E_INVALID_OPTION", async () => {
    const r = await cover(["--input", path.join(dir, "clip.gif")], stubNone);
    expect([r.code, r.j.error?.code]).toEqual([2, "E_INVALID_OPTION"]);
  });

  it("--at 形态非法 / --scale 越界 / --min-confidence 越界 / --color 注入 → E_INVALID_OPTION", async () => {
    const cases: string[][] = [
      ["--at", "10,20"],
      ["--at", "10,20,0"],
      ["--at", "a,b,c"],
      ["--scale", "4"],
      ["--scale", "0.2"],
      ["--min-confidence", "1.5"],
      ["--color", '#ff"/><script'],
    ];
    for (const extra of cases) {
      const r = await cover(["--input", gray, ...extra], stubNone);
      expect(r.code, `${extra.join(" ")} → ${r.stdout.trim()}`).toBe(2);
      expect(r.j.error?.code).toBe("E_INVALID_OPTION");
    }
  });

  it("spec 自省含 media-face-cover 且 source 为 plugin:media-image", async () => {
    const r = await cli(["--json", "spec"], {});
    expect(r.code).toBe(0);
    const spec = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string; options: { flags: string }[] }[] };
    };
    const cmd = spec.data.commands.find((c) => c.name === "media-face-cover");
    expect(cmd?.source).toBe("plugin:media-image");
    expect(cmd?.options.map((o) => o.flags)).toContain("--at <x,y,r...>");
  });
});

describe("media-face-cover 人工圆 --at（不依赖 Vision）", () => {
  it("--at 100,100,40：圆心变白、角落不变，默认旁路 .covered.png", async () => {
    const r = await cover(["--input", gray, "--at", "100,100,40"], stubNone);
    expect(r.code).toBe(0);
    expect(r.j.ok).toBe(true);
    expect(r.j.data).toMatchObject({
      path: path.join(dir, "photo.covered.png"),
      width: 200,
      height: 200,
      covered: 1,
      scale: 1.2,
      color: "#FFFFFF",
      minConfidence: 0.3,
      manualCircles: 1,
    });
    expect(r.j.warnings).toEqual([]);
    expect(r.j.data.faces).toEqual([{ x: 100, y: 100, r: 40, confidence: null, source: "manual" }]);
    const out = r.j.data.path ?? "";
    expect(await pixel(out, 100, 100)).toEqual([255, 255, 255]);
    expect(await pixel(out, 10, 10)).toEqual([128, 128, 128]);
    // 半径 40 的圆盖不到 (150,100)（距圆心 50）
    expect(await pixel(out, 150, 100)).toEqual([128, 128, 128]);
  });

  it("--at 可重复多个并与 --color 一起生效", async () => {
    const out = path.join(dir, "multi.png");
    const r = await cover(
      [
        "--input",
        gray,
        "--output",
        out,
        "--at",
        "60,60,20",
        "--at",
        "150,150,25",
        "--color",
        "#000000",
      ],
      stubNone,
    );
    expect(r.code).toBe(0);
    expect(r.j.data.covered).toBe(2);
    expect(await pixel(out, 60, 60)).toEqual([0, 0, 0]);
    expect(await pixel(out, 150, 150)).toEqual([0, 0, 0]);
    expect(await pixel(out, 100, 100)).toEqual([128, 128, 128]);
  });

  it("引擎不可用时 --at 降级为警告但仍然出图", async () => {
    const out = path.join(dir, "degraded.png");
    const r = await cover(
      ["--input", gray, "--output", out, "--at", "100,100,40"],
      "/nonexistent-face-bin",
    );
    expect(r.code).toBe(0);
    expect(r.j.data.covered).toBe(1);
    expect(r.j.warnings).toEqual([
      {
        code: "E_MISSING_DEPENDENCY",
        message: expect.stringContaining("FACE_BIN"),
        plugin: "media-image",
      },
    ]);
    expect(await pixel(out, 100, 100)).toEqual([255, 255, 255]);
  });

  it("圆心 clamp 进画布：越界人工圆不会整颗跑出图外", async () => {
    const out = path.join(dir, "clamped.png");
    const r = await cover(["--input", gray, "--output", out, "--at", "9999,9999,10"], stubNone);
    expect(r.code).toBe(0);
    expect(r.j.data.faces?.[0]).toMatchObject({ x: 200, y: 200 });
    expect(existsSync(out)).toBe(true);
  });

  it("JS 画布随 EXIF 方向摆正（200x100 + orientation 6 → 100x200）", async () => {
    const out = path.join(dir, "rot.covered.jpg");
    const stubRot = await stub("stub-rot", say('{"width":100,"height":200,"faces":[]}'));
    const r = await cover(
      ["--input", path.join(dir, "rot.jpg"), "--output", out, "--at", "50,180,15"],
      stubRot,
    );
    expect(r.code).toBe(0);
    expect(r.j.data).toMatchObject({ width: 100, height: 200, covered: 1 });
    // jpeg 有损，只断言显著变白
    expect((await pixel(out, 50, 180))[0] ?? 0).toBeGreaterThan(240);
  });
});

describe("media-face-cover Vision 路径（stub 检测器）", () => {
  it("圆 = 人脸框内切圆 × scale，白像素落在框中心", async () => {
    const out = path.join(dir, "vision.png");
    const r = await cover(["--input", gray, "--output", out], stubTwo);
    expect(r.code).toBe(0);
    expect(r.j.data.covered).toBe(2);
    expect(r.j.data.faces).toEqual([
      { x: 50, y: 60, r: 36, confidence: 0.9, source: "vision" },
      { x: 140, y: 120, r: 24, confidence: 0.5, source: "vision" },
    ]);
    expect(await pixel(out, 50, 60)).toEqual([255, 255, 255]);
    expect(await pixel(out, 140, 120)).toEqual([255, 255, 255]);
    expect(await pixel(out, 10, 10)).toEqual([128, 128, 128]);
  });

  it("--min-confidence 滤掉低置信度脸；--at 与检测结果合并", async () => {
    const filtered = await cover(
      ["--input", gray, "--output", path.join(dir, "f.png"), "--min-confidence", "0.6"],
      stubTwo,
    );
    expect(filtered.j.data.faces).toEqual([
      { x: 50, y: 60, r: 36, confidence: 0.9, source: "vision" },
    ]);
    const merged = await cover(
      ["--input", gray, "--output", path.join(dir, "m.png"), "--at", "10,10,5"],
      stubTwo,
    );
    expect(merged.j.data.covered).toBe(3);
    expect(merged.j.data.faces?.map((f) => f.source)).toEqual(["vision", "vision", "manual"]);
  });

  it("检测器画布与实际画布不一致时按比例映射", async () => {
    const out = path.join(dir, "scaled.png");
    const stubBig = await stub(
      "stub-big",
      say(
        '{"width":400,"height":400,"faces":[{"x":50,"y":60,"w":150,"h":200,"confidence":0.9,"quality":null}]}',
      ),
    );
    const r = await cover(["--input", gray, "--output", out], stubBig);
    expect(r.code).toBe(0);
    expect(r.j.data.faces?.[0]).toMatchObject({ x: 62.5, y: 80, r: 45 });
    expect(await pixel(out, 62, 80)).toEqual([255, 255, 255]);
  });

  it("0 张脸：仍写图 + E_NO_FACE_DETECTED 警告 + 退出 0", async () => {
    const out = path.join(dir, "noface.png");
    const r = await cover(["--input", gray, "--output", out], stubNone);
    expect(r.code).toBe(0);
    expect(r.j.ok).toBe(true);
    expect(r.j.data.covered).toBe(0);
    expect(r.j.warnings).toEqual([
      {
        code: "E_NO_FACE_DETECTED",
        message: expect.stringContaining("--at"),
        plugin: "media-image",
      },
    ]);
    expect(existsSync(out)).toBe(true);
    expect(await pixel(out, 100, 100)).toEqual([128, 128, 128]);
  });

  it("检测器失败：无 --at → E_PROVIDER_ERROR 退出 3；有 --at → 降级警告继续", async () => {
    const failStub = await stub(
      "stub-fail",
      "printf 'E:vision request failed: boom\\n' >&2; exit 3",
    );
    const hard = await cover(["--input", gray, "--output", path.join(dir, "e1.png")], failStub);
    expect(hard.code).toBe(3);
    expect(hard.j.error).toMatchObject({
      code: "E_PROVIDER_ERROR",
      message: expect.stringContaining("boom"),
      details: { source: "vision" },
    });
    expect(existsSync(path.join(dir, "e1.png"))).toBe(false);

    const soft = await cover(
      ["--input", gray, "--output", path.join(dir, "e2.png"), "--at", "30,30,10"],
      failStub,
    );
    expect(soft.code).toBe(0);
    expect(soft.j.data.covered).toBe(1);
    expect(soft.j.warnings.map((w) => w.code)).toContain("E_PROVIDER_ERROR");
    expect(await pixel(path.join(dir, "e2.png"), 30, 30)).toEqual([255, 255, 255]);
  });

  it("检测器输出非法 JSON → E_PROVIDER_ERROR details.reason=malformed", async () => {
    const junk = await stub("stub-junk", "printf 'hello world\\n'");
    const r = await cover(["--input", gray, "--output", path.join(dir, "e3.png")], junk);
    expect(r.code).toBe(3);
    expect(r.j.error?.code).toBe("E_PROVIDER_ERROR");
    expect(r.j.error?.details).toMatchObject({ source: "vision", reason: "malformed" });
  });
});

describe("media-face-cover 文件夹批量", () => {
  it("默认输出 ./face-cover：坏图进 failed，二次运行不吃自己的产物", async () => {
    const inputDir = path.join(dir, "batch");
    const first = await cover(["--input", "."], stubTwo, inputDir);
    expect(first.code, first.stderr).toBe(0);
    expect(first.j.data).toMatchObject({
      outputDir: path.join(inputDir, "face-cover"),
      total: 3, // a.png + b.png + broken.png（sub 不递归、note.txt 被扩展名过滤）
      scale: 1.2,
    });
    expect(first.j.data.results).toHaveLength(2);
    expect(first.j.data.results?.[0].covered).toBe(2);
    expect(first.j.data.failed).toHaveLength(1);
    expect(String(first.j.data.failed?.[0].file)).toContain("broken.png");
    expect(existsSync(path.join(inputDir, "face-cover", "a.png"))).toBe(true);
    expect(existsSync(path.join(inputDir, "face-cover", "a.covered.png"))).toBe(false);
    // 二次运行：默认输出目录已被 excludeUnder 排除，总数不变
    expect((await cover(["--input", "."], stubTwo, inputDir)).j.data.total).toBe(3);
  });

  it("--recursive 镜像相对目录结构，单张失败不中断整批", async () => {
    const src = path.join(dir, "grid");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await grey().png().toFile(path.join(src, "a.png"));
    await grey()
      .png()
      .toFile(path.join(src, "sub", "c.png"));
    await writeFile(path.join(src, "broken.jpg"), "not an image");
    const r = await cover(
      ["--input", src, "--output", path.join(dir, "rec-out"), "--recursive"],
      stubTwo,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.j.data.total).toBe(3);
    expect(r.j.data.results?.map((item) => item.path).sort()).toEqual(
      [path.join(dir, "rec-out", "a.png"), path.join(dir, "rec-out", "sub", "c.png")].sort(),
    );
    expect(r.j.data.failed).toHaveLength(1);
  });
});

// 真实 Apple Vision 集成：首次运行现场 swiftc 编译并落 ~/.media-cli/cache。
// 纯色底图必然 0 张脸，所以这条只验「编译 + spawn + stdout JSON 契约」端到端通；
// 真人脸检出与白圆对位由手工验证覆盖（2026-10-14 实测：2048x2048 角色表 CR61.jpg 出 3 框
// —— 正脸/侧脸/大头像，九宫格分镜页 S019.png 出 9 框每格一个，圆全部落在脸上无偏移）。
const canIntegrate =
  process.platform === "darwin" &&
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((item) => item !== "" && existsSync(path.join(item, "swiftc")));

describe.skipIf(!canIntegrate)("media-face-cover 集成（macOS Vision 真引擎）", () => {
  it("真引擎跑通：纯色图 0 张脸 → 原图副本 + E_NO_FACE_DETECTED + 退出 0", async () => {
    const out = path.join(dir, "real.png");
    const r = await cli(["--json", "media-face-cover", "--input", gray, "--output", out], {
      FACE_BIN: undefined, // 从继承环境删掉桩，走真实的缓存/编译分支
    });
    expect(r.code, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.data.covered).toBe(0);
    expect(parsed.warnings.map((w) => w.code)).toContain("E_NO_FACE_DETECTED");
    expect(await pixel(out, 100, 100)).toEqual([128, 128, 128]);
  }, 180_000);
});
