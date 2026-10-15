import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type CliRun, cli } from "./helpers/cli";

// spawn 真进程的 e2e：全量并发时单条会超过 vitest 默认 5s（实测 F7 字号用例在满载下超时），
// 故整文件设 30s 上限，与仓库既有慢用例显式 `, 30000)` 的口径一致。
vi.setConfig({ testTimeout: 30_000 });

// media-grid-caption 的契约全部在这里钉死：三级定位优先级、每格黑条的像素位置、
// 墨迹量（D33 防 tofu）、兜底外扩版式、以及「条数不匹配只警告不失败」。
// 断言一律读真实输出像素 —— 只看 data 字段证明不了字画到了正确的格上。

interface CaptionData {
  path: string;
  bytes: number;
  width: number;
  height: number;
  originalHeight?: number;
  cells: number;
  bars: number;
  captions?: number;
  layout: string;
  source: string;
  minFontSize: number | null;
  maxFontSize: number | null;
  fontSize?: number;
  fontSizePerCell?: { index: number; fontSize: number }[];
  lines: number;
  truncated?: number;
  empty?: boolean;
  minorOverlaps?: number;
  maxOverlap?: number;
  font: string;
  textColor: string;
  opacity: number;
  padding: number;
  position: string;
}

interface Envelope {
  ok: boolean;
  data: CaptionData;
  warnings: { code: string; message: string; plugin?: string }[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface Run extends CliRun {
  j: Envelope;
}

const W = 512;
const BORDER = 16;
const GUTTER = 8;
const SIZE = (W - 2 * BORDER - GUTTER) / 2; // 236
const COLORS = ["#c03030", "#2060c0", "#2a9050", "#c0a020"];
// 满幅（F2）：内容一直顶到图片边缘，只有中间 8px 十字白缝，**没有任何外边距**
const FB_SIZE = (W - GUTTER) / 2; // 252
const FB_POSITIONS = [
  [0, 0],
  [FB_SIZE + GUTTER, 0],
  [0, FB_SIZE + GUTTER],
  [FB_SIZE + GUTTER, FB_SIZE + GUTTER],
];

let dir = "";
let grid = ""; // 2x2 规则宫格（白带分隔）：本地检测必须检出 4 格
let fullBleed = ""; // 满幅 2x2（无外边距）：老取色会拒绝检出
let gradient = ""; // 对角渐变无任何分隔线：本地检测必须判失败 → 兜底
let cellsFile = "";
let captionsFile = "";

async function run(args: string[], cwd?: string): Promise<Run> {
  const r = await cli(["--json", "media-grid-caption", ...args], {}, cwd);
  return { ...r, j: JSON.parse(r.stdout) as Envelope };
}

async function channelCount(file: string) {
  return (await sharp(file).metadata()).channels ?? 0;
}

// 读单个像素（左上原点，与 cells schema 同一坐标系）
async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
}

// 区域内「亮成白字」的像素数：D33 的墨迹断言（防中文渲染成 tofu 或整条命令静默产空图）
async function brightPixels(file: string, box: { x: number; y: number; w: number; h: number }) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let hit = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if ((data[i] ?? 0) > 200 && (data[i + 1] ?? 0) > 200 && (data[i + 2] ?? 0) > 200) hit += 1;
    }
  }
  return hit;
}

async function darkPixels(file: string, box: { x: number; y: number; w: number; h: number }) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let hit = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if ((data[i] ?? 0) < 60 && (data[i + 1] ?? 0) < 60 && (data[i + 2] ?? 0) < 60) hit += 1;
    }
  }
  return hit;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "media-grid-caption-e2e-"));

  const blocks = [];
  const positions = [
    [BORDER, BORDER],
    [BORDER + GUTTER + SIZE, BORDER],
    [BORDER, BORDER + GUTTER + SIZE],
    [BORDER + GUTTER + SIZE, BORDER + GUTTER + SIZE],
  ];
  for (let i = 0; i < 4; i += 1) {
    blocks.push({
      input: await sharp({
        create: { width: SIZE, height: SIZE, channels: 3, background: COLORS[i] },
      })
        .png()
        .toBuffer(),
      left: positions[i][0],
      top: positions[i][1],
    });
  }
  grid = path.join(dir, "grid2x2.png");
  await sharp({ create: { width: W, height: W, channels: 3, background: "#ffffff" } })
    .composite(blocks)
    .png()
    .toFile(grid);

  // 满幅 2x2：老算法只取四边 8px 条带的中位数当背景 → 取到的是内容色 → 拒绝检出（F2）
  const bleedBlocks = [];
  for (let i = 0; i < 4; i += 1) {
    bleedBlocks.push({
      input: await sharp({
        create: { width: FB_SIZE, height: FB_SIZE, channels: 3, background: COLORS[i] },
      })
        .png()
        .toBuffer(),
      left: FB_POSITIONS[i][0],
      top: FB_POSITIONS[i][1],
    });
  }
  fullBleed = path.join(dir, "fullbleed2x2.png");
  await sharp({ create: { width: W, height: W, channels: 3, background: "#ffffff" } })
    .composite(bleedBlocks)
    .png()
    .toFile(fullBleed);

  // 对角渐变：每行每列都不是纯色带，本地检测无从下手 → 必须走兜底
  const raw = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = Math.round(((x + y) / (2 * (W - 1))) * 255);
      const i = (y * W + x) * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  gradient = path.join(dir, "no-gutter.png");
  await sharp(raw, { raw: { width: W, height: W, channels: 3 } })
    .png()
    .toFile(gradient);

  cellsFile = path.join(dir, "cells.json");
  await writeFile(
    cellsFile,
    JSON.stringify({
      cells: [
        { index: 0, x: BORDER, y: BORDER, w: SIZE, h: SIZE },
        { index: 1, x: BORDER + GUTTER + SIZE, y: BORDER, w: SIZE, h: SIZE },
        { index: 2, x: BORDER, y: BORDER + GUTTER + SIZE, w: SIZE, h: SIZE },
        { index: 3, x: BORDER + GUTTER + SIZE, y: BORDER + GUTTER + SIZE, w: SIZE, h: SIZE },
      ],
      image: { width: W, height: W },
      source: "manual",
      model: "hand-written",
    }),
  );

  captionsFile = path.join(dir, "captions.json");
  await writeFile(
    captionsFile,
    JSON.stringify([
      { index: 0, text: "第一格字幕" },
      { index: 1, text: '第二格 <script>alert(1)</script> & "引号"' },
      { index: 2, text: "第三格很长".repeat(12) },
      { index: 3, text: "第四格" },
    ]),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("media-grid-caption e2e", () => {
  it("规则宫格不带 --cells：本地检出 4 格、每格底部黑条、整图尺寸不变", async () => {
    const out = path.join(dir, "auto.png");
    const r = await run(["--input", grid, "--captions", captionsFile, "--output", out]);
    expect(r.code).toBe(0);
    expect(r.j.data).toMatchObject({
      cells: 4,
      bars: 4,
      layout: "in-cell",
      source: "auto",
      width: W,
      height: W,
    });
    expect((await sharp(out).metadata()).width).toBe(W);
    expect((await sharp(out).metadata()).height).toBe(W);
    // 第 0 格底部有条（暗），格心仍是原色块
    const barBox = { x: BORDER + 4, y: BORDER + SIZE - 20, w: SIZE - 8, h: 12 };
    expect(await darkPixels(out, barBox)).toBeGreaterThan(0);
    expect(await pixel(out, BORDER + SIZE / 2, BORDER + SIZE / 2)).toEqual([192, 48, 48]);
    // 分隔带不被污染：黑条只出现在自己格内
    expect(await pixel(out, BORDER + SIZE + GUTTER / 2, BORDER + SIZE - 20)).toEqual([
      255, 255, 255,
    ]);
  });

  it("F2 满幅 2x2（内容顶到图片边缘、没有外边距）：本地照样检出 4 格，source=auto", async () => {
    const out = path.join(dir, "fullbleed.png");
    const r = await run(["--input", fullBleed, "--captions", captionsFile, "--output", out]);
    expect(r.code).toBe(0);
    expect(r.j.data).toMatchObject({
      source: "auto",
      cells: 4,
      bars: 4,
      layout: "in-cell",
      width: W,
      height: W,
    });
    expect(r.j.warnings.map((w) => w.code)).not.toContain("E_GRID_NOT_DETECTED");
    for (const [left, top] of FB_POSITIONS) {
      const box = { x: left + 4, y: top + FB_SIZE - 20, w: FB_SIZE - 8, h: 12 };
      expect(await darkPixels(out, box)).toBeGreaterThan(0);
    }
    // 中间的十字缝没有被黑条污染（条只在自己象限里）
    expect(await pixel(out, FB_SIZE + 2, 100)).toEqual([255, 255, 255]);
    expect(await pixel(out, 100, FB_SIZE + 2)).toEqual([255, 255, 255]);
    // 读到的四角就是四个象限的原色（说明格边界取的是缝，不是内容里随便切的线）
    expect(await pixel(out, 10, 10)).toEqual([192, 48, 48]);
    expect(await pixel(out, FB_SIZE + 10, 10)).toEqual([32, 96, 192]);
    expect(await pixel(out, FB_SIZE + 10, FB_SIZE + 10)).toEqual([192, 160, 32]);
  });

  it("F3 相互重叠的 cells → E_INVALID_OPTION 点名是哪两格；--allow-overlap 才放行", async () => {
    const overlap = path.join(dir, "overlap-cells.json");
    await writeFile(
      overlap,
      JSON.stringify({
        cells: [
          { index: 0, x: 0, y: 0, w: 300, h: 300 },
          { index: 1, x: 200, y: 0, w: 312, h: 300 }, // 与第 0 格重叠 100x300
        ],
        image: { width: W, height: W },
        source: "vision",
      }),
    );
    const bad = await run(["--input", grid, "--cells", overlap]);
    expect(bad.code).toBe(2);
    expect(bad.j.ok).toBe(false);
    expect(bad.j.error?.code).toBe("E_INVALID_OPTION");
    expect(bad.j.error?.details).toMatchObject({
      option: "--cells",
      reason: "overlapping_cells",
      cells: [0, 1],
      total: 1,
    });
    expect(bad.j.error?.message).toContain("第 0 格与第 1 格重叠 100x300px");
    expect(bad.j.error?.message).toContain("--allow-overlap");

    const out = path.join(dir, "overlap.png");
    const ok = await run([
      "--input",
      grid,
      "--cells",
      overlap,
      "--allow-overlap",
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(ok.code).toBe(0);
    expect(ok.j.data).toMatchObject({ cells: 2, bars: 2, layout: "in-cell" });
  });

  // F2：消费侧的阈值必须**有刻度**。视觉模型的坐标放大回原图必然带 ±1px 薄条（实测 0.2% 量级），
  // 一律 E_INVALID_OPTION 等于把兄弟命令 doubao-grid-locate 的产物打回去（流水线实测断在这）。
  it("F2 小重叠（占较小格 0.8% ≤ --max-overlap 0.05）→ E_CELLS_OVERLAP 警告 + exit 0 + 照常渲染", async () => {
    const slight = path.join(dir, "slight-overlap.json");
    await writeFile(
      slight,
      JSON.stringify({
        cells: [
          { index: 0, x: 0, y: 0, w: 256, h: 256 },
          { index: 1, x: 254, y: 0, w: 256, h: 256 }, // 与第 0 格重叠 2x256 = 占较小格 0.8%
        ],
        image: { width: W, height: W },
        source: "vision",
      }),
    );
    const out = path.join(dir, "slight.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      slight,
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.ok).toBe(true);
    const warning = r.j.warnings.find((w) => w.code === "E_CELLS_OVERLAP");
    expect(warning?.message).toContain("第 0 格与第 1 格重叠 2x256px");
    expect(warning?.message).toContain("--max-overlap");
    expect(warning?.plugin).toBe("media-image");
    // 真出图了：两格各有一条黑底白字（不是拒收，也不是静默只画一条）
    expect(r.j.data).toMatchObject({
      cells: 2,
      bars: 2,
      layout: "in-cell",
      minorOverlaps: 1,
      maxOverlap: 0.05,
    });
    expect(await darkPixels(out, { x: 6, y: 236, w: 244, h: 12 })).toBeGreaterThan(0);
    expect(await brightPixels(out, { x: 60, y: 232, w: 130, h: 20 })).toBeGreaterThan(20);
  });

  // 管线不变量的端到端回归 —— 实测断链点就在这里。
  // doubao-grid-locate 的修复窗口是「薄边 ≤5%」（grid-image.mjs 的 DEFAULT_OVERLAP_LIMIT），
  // 且切齐是尽力而为（削掉较大格 >25% 面积的那一刀它主动放弃），所以窗口内的残渣**有权**被写进
  // --output。消费侧默认带子若比它窄（旧值 0.02），兄弟命令的产物就会被 E_INVALID_OPTION 拒收、
  // 而且**一个像素的文件都不写** —— 「产出即可消费、零转换」的冻结契约当场失效。
  it("不变量：产出侧窗口内的实测残渣（占较小格 3.5%，> 旧默认 0.02）默认设置直接消费 → exit 0 + 真出图", async () => {
    const residue = path.join(dir, "residue-cells.json");
    await writeFile(
      residue,
      JSON.stringify({
        cells: [
          { index: 0, x: 0, y: 0, w: 256, h: 256 },
          { index: 1, x: 247, y: 0, w: 256, h: 256 }, // 重叠 9x256 = 占较小格 3.5%（S019 实测 3.7% 同档）
        ],
        image: { width: W, height: W },
        source: "vision",
      }),
    );
    const out = path.join(dir, "residue.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      residue,
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.ok).toBe(true);
    expect(r.j.error).toBeUndefined();
    expect(r.j.data).toMatchObject({
      layout: "in-cell",
      source: "vision",
      cells: 2,
      bars: 2,
      minorOverlaps: 1,
      maxOverlap: 0.05,
    });
    expect(r.j.warnings.find((w) => w.code === "E_CELLS_OVERLAP")?.message).toContain("9x256px");
    // 真的落盘了（旧行为：exit 2 + 不写文件），且两格各画出一条带白字的黑条
    expect((await sharp(out).metadata()).width).toBe(W);
    expect(await brightPixels(out, { x: 60, y: 232, w: 130, h: 20 })).toBeGreaterThan(20);
  });

  // 不变量不是「放行一切」：真误检（两格 30% 重合）仍然硬拒、仍然不产文件
  it("不变量的另一头：两格 30% 重合 → 默认仍然 E_INVALID_OPTION 且不写任何文件", async () => {
    const coincident = path.join(dir, "coincident-cells.json");
    await writeFile(
      coincident,
      JSON.stringify({
        cells: [
          { index: 0, x: 0, y: 0, w: 300, h: 300 },
          { index: 1, x: 0, y: 210, w: 300, h: 300 }, // 重叠 300x90 = 占较小格 30%
        ],
        image: { width: W, height: W },
        source: "vision",
      }),
    );
    const out = path.join(dir, "coincident.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      coincident,
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(r.code).toBe(2);
    expect(r.j.error?.code).toBe("E_INVALID_OPTION");
    expect(r.j.error?.details).toMatchObject({
      reason: "overlapping_cells",
      cells: [0, 1],
      maxOverlap: 0.05,
    });
    expect(r.j.error?.message).toContain("占较小格 30%");
    await expect(access(out)).rejects.toThrow();
  });

  it("F2 小重叠可以按 --max-overlap 收紧：0 时同一份 JSON 变成硬错误（exit 2）", async () => {
    const slight = path.join(dir, "slight-overlap.json");
    const strict = await run([
      "--input",
      grid,
      "--cells",
      slight,
      "--captions",
      captionsFile,
      "--max-overlap",
      "0",
    ]);
    expect(strict.code).toBe(2);
    expect(strict.j.error?.code).toBe("E_INVALID_OPTION");
    expect(strict.j.error?.details).toMatchObject({ reason: "overlapping_cells", maxOverlap: 0 });
    // --allow-overlap 仍然压掉一切（包括警告）
    const allowed = await run([
      "--input",
      grid,
      "--cells",
      slight,
      "--captions",
      captionsFile,
      "--max-overlap",
      "0",
      "--allow-overlap",
      "--output",
      path.join(dir, "slight-allowed.png"),
    ]);
    expect(allowed.code).toBe(0);
    expect(allowed.j.warnings.map((w) => w.code)).not.toContain("E_CELLS_OVERLAP");
    expect(allowed.j.data.minorOverlaps).toBe(0);
  });

  it("F2 大重叠可以把 --max-overlap 放宽成警告（刻意的分层版式不用非改 JSON 不可）", async () => {
    const overlap = path.join(dir, "overlap-cells.json");
    const loose = await run([
      "--input",
      grid,
      "--cells",
      overlap, // 第 0/1 格重叠 100x300 = 占较小格 33%
      "--captions",
      captionsFile,
      "--max-overlap",
      "0.5",
      "--output",
      path.join(dir, "overlap-loose.png"),
    ]);
    expect(loose.code).toBe(0);
    expect(loose.j.warnings.map((w) => w.code)).toContain("E_CELLS_OVERLAP");
    expect(loose.j.data).toMatchObject({ cells: 2, bars: 2, minorOverlaps: 1, maxOverlap: 0.5 });
    for (const bad of ["-0.1", "1.5", "abc", ""]) {
      const r = await run(["--input", grid, "--cells", overlap, "--max-overlap", bad]);
      expect(r.code).toBe(2);
      expect(r.j.error?.details).toMatchObject({ option: "--max-overlap" });
    }
  });

  it("F2 大重叠的报错给的是能落地的出路，不把用户踢回刚产出这份 JSON 的命令", async () => {
    const overlap = path.join(dir, "overlap-cells.json");
    const bad = await run(["--input", grid, "--cells", overlap]);
    expect(bad.code).toBe(2);
    const message = bad.j.error?.message ?? "";
    expect(message).not.toContain("doubao-grid-locate");
    expect(message).toContain("--allow-overlap");
    expect(message).toContain("编辑");
    expect(message).toContain("--cols/--rows");
    expect(message).toContain("占较小格 33%");
  });

  it("F6 三条对得上 + 一条 index 落空：只出**一条**自洽的 E_PARTIAL_INPUT 警告", async () => {
    const mixed = path.join(dir, "mixed-captions.json");
    await writeFile(
      mixed,
      JSON.stringify([
        { index: 0, text: "甲" },
        { index: 1, text: "乙" },
        { index: 2, text: "丙" },
        { index: 7, text: "没有第 7 格" },
      ]),
    );
    const out = path.join(dir, "partial-once.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      mixed,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    const partial = r.j.warnings.filter((w) => w.code === "E_PARTIAL_INPUT");
    expect(partial).toHaveLength(1);
    expect(partial[0].message).toContain("4 格里有 1 格没有字幕文本（index 3");
    expect(partial[0].message).toContain("1 条字幕找不到对应格（index 7");
    // 老 bug：同一份输入同时给出「少于格数」与「多于格数」两条互相矛盾的警告
    expect(partial[0].message).not.toContain("少于格数");
    expect(partial[0].message).not.toContain("多于格数");
    expect(r.j.data.bars).toBe(3);
  });

  it("F7 字号按格报：min/max 是聚合口径，fontSizePerCell 才是实际画出来的字号", async () => {
    const out = path.join(dir, "sizes.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    // fontSize 从此只是「用户请求的字号」（null = 自动档，与 media-watermark 的 echo 同一语义）；
    // 老 bug 是它被拿来回填各格最小值（实测报 14，而多数条画的是 26–34），现在实际字号看下面三个字段
    expect(r.j.data.fontSize).toBeNull();
    expect(r.j.data.fontSizePerCell).toHaveLength(4);
    const perCell = r.j.data.fontSizePerCell ?? [];
    const sizes = perCell.map((s) => s.fontSize);
    expect(perCell.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(r.j.data.minFontSize).toBe(Math.min(...sizes));
    expect(r.j.data.maxFontSize).toBe(Math.max(...sizes));
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(14);

    // 关键回归：每格字号不同时，聚合口径绝不冒充实际字号（老代码只会报最小的那个）
    const sized = path.join(dir, "sized-cells.json");
    const perCellSizes = [40, 28, 34, 20];
    await writeFile(
      sized,
      JSON.stringify({
        cells: [BORDER, BORDER + GUTTER + SIZE, BORDER, BORDER + GUTTER + SIZE].map((x, i) => ({
          index: i,
          x,
          y: i < 2 ? BORDER : BORDER + GUTTER + SIZE,
          w: SIZE,
          h: SIZE,
          fontSize: perCellSizes[i],
        })),
        image: { width: W, height: W },
        source: "manual",
      }),
    );
    const shorts = path.join(dir, "short-captions.json");
    await writeFile(
      shorts,
      JSON.stringify([
        { index: 0, text: "甲" },
        { index: 1, text: "乙" },
        { index: 2, text: "丙" },
        { index: 3, text: "丁" },
      ]),
    );
    const sizedOut = path.join(dir, "sized.png");
    const r3 = await run([
      "--input",
      grid,
      "--cells",
      sized,
      "--captions",
      shorts,
      "--output",
      sizedOut,
    ]);
    expect(r3.code).toBe(0);
    expect(r3.j.data.fontSizePerCell).toEqual(
      perCellSizes.map((fontSize, index) => ({ index, fontSize })),
    );
    expect(r3.j.data).toMatchObject({ minFontSize: 20, maxFontSize: 40 });

    // --font-size 显式覆盖时：echo 与逐格实际值一致，min/max 也同一档
    const fixed = path.join(dir, "sizes-fixed.png");
    const r2 = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      captionsFile,
      "--font-size",
      "30",
      "--output",
      fixed,
    ]);
    expect(r2.j.data).toMatchObject({ fontSize: 30, minFontSize: 30, maxFontSize: 30 });
    expect((r2.j.data.fontSizePerCell ?? []).map((s) => s.fontSize)).toEqual([30, 30, 30, 30]);
  });

  it("--cells 人工四格 + --captions：黑条落在指定格内，墨迹量 > 0（防 tofu）", async () => {
    const out = path.join(dir, "manual.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.data).toMatchObject({ layout: "in-cell", source: "manual", cells: 4 });
    expect(r.j.warnings.map((w) => w.code)).not.toContain("E_GRID_NOT_DETECTED");
    for (const [x, y] of [
      [BORDER, BORDER],
      [BORDER + GUTTER + SIZE, BORDER],
      [BORDER, BORDER + GUTTER + SIZE],
      [BORDER + GUTTER + SIZE, BORDER + GUTTER + SIZE],
    ]) {
      const box = { x: x + 6, y: y + SIZE - 30, w: SIZE - 12, h: 24 };
      expect(await darkPixels(out, box)).toBeGreaterThan(SIZE * 4);
      expect(await brightPixels(out, box)).toBeGreaterThan(20);
    }
  });

  it("文本含 <script> 与 & 也正常渲染（escapeXml 生效且不报错）", async () => {
    const out = path.join(dir, "escape.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      captionsFile,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    // 若未转义，librsvg 会因非法 XML 报错或整段不画；这里第二格照样有白字墨迹
    const box = { x: BORDER + GUTTER + SIZE + 6, y: BORDER + SIZE - 40, w: SIZE - 12, h: 34 };
    expect(await brightPixels(out, box)).toBeGreaterThan(20);
    expect(r.stdout + r.stderr).not.toContain("alert");
  });

  it("超长字幕：字号降到下限仍放不下 → 截到 4 行加 …，附 E_TEXT_TRUNCATED 且 exit 0", async () => {
    const long = path.join(dir, "long.json");
    await writeFile(long, JSON.stringify([{ index: 0, text: "这段字幕长得离谱".repeat(20) }]));
    const out = path.join(dir, "truncated.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      long,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.warnings.map((w) => w.code)).toContain("E_TEXT_TRUNCATED");
    expect(r.j.data.bars).toBe(1);
    expect(r.j.data.lines).toBeLessThanOrEqual(4); // 上限 4 行
  });

  it("无分隔线的渐变图：明确拒绝套版式，外扩到底部 + E_GRID_NOT_DETECTED + exit 0", async () => {
    const out = path.join(dir, "fallback.png");
    const r = await run(["--input", gradient, "--captions", captionsFile, "--output", out]);
    expect(r.code).toBe(0);
    // F5：兜底版式的 source 是 §2 新增的 "none"，不再吐 null（AI 调用方按枚举分支，不该看到 null）
    expect(r.j.data).toMatchObject({
      layout: "fallback-bottom",
      source: "none",
      originalHeight: W,
    });
    expect(r.j.data.height).toBeGreaterThan(W);
    expect(r.j.warnings.map((w) => w.code)).toEqual(["E_GRID_NOT_DETECTED"]);
    // 兜底版式整条只有一个字号：min 与 max 同值（F7 的聚合口径在这里退化成单值）
    expect(r.j.data.minFontSize).toBe(r.j.data.maxFontSize);
    expect(r.j.data.fontSizePerCell).toBeUndefined();
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(r.j.data.height);
    // 原图区域一个像素没被改动（外扩而非覆盖）
    expect(await pixel(out, 10, 10)).toEqual(await pixel(gradient, 10, 10));
    expect(await pixel(out, W - 10, W - 10)).toEqual(await pixel(gradient, W - 10, W - 10));
    // 外扩条是半透明黑底 + 白字：PNG 保留 alpha，条内既有暗像素也有白字墨迹
    const barBox = { x: 4, y: W + 4, w: W - 8, h: r.j.data.height - W - 8 };
    expect(await darkPixels(out, barBox)).toBeGreaterThan(0);
    expect(await brightPixels(out, barBox)).toBeGreaterThan(30);
    expect(await channelCount(out)).toBe(4);
  });

  it("--opacity 1 → 黑条区域纯黑（R=G=B=0）", async () => {
    const out = path.join(dir, "opaque.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      captionsFile,
      "--opacity",
      "1",
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.data.opacity).toBe(1);
    // 取黑条最左端的空白处（文字居中，左侧必是纯条底）
    const px = await pixel(out, BORDER + 2, BORDER + SIZE - 8);
    expect(px).toEqual([0, 0, 0]);
  });

  it("--cols/--rows 等分：跳过检测，source=manual 且格数=cols×rows", async () => {
    const out = path.join(dir, "equal.png");
    const r = await run([
      "--input",
      gradient,
      "--captions",
      captionsFile,
      "--cols",
      "2",
      "--rows",
      "2",
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.data).toMatchObject({ cells: 4, source: "manual", layout: "in-cell", height: W });
  });

  it("--no-locate：关掉检测后即使规则宫格也走兜底", async () => {
    const out = path.join(dir, "nolocate.png");
    const r = await run([
      "--input",
      grid,
      "--captions",
      captionsFile,
      "--no-locate",
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.data.layout).toBe("fallback-bottom");
    expect(r.j.data.height).toBeGreaterThan(W);
  });

  it("字幕条数少于格数 → E_PARTIAL_INPUT 警告、exit 0、只写有文本的格", async () => {
    const thin = path.join(dir, "thin.json");
    await writeFile(thin, JSON.stringify([{ index: 0, text: "只有一句" }]));
    const out = path.join(dir, "partial.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      thin,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.warnings.map((w) => w.code)).toContain("E_PARTIAL_INPUT");
    expect(r.j.data.bars).toBe(1);
    // 只有第 0 格有字幕，第 1 格保持干净（原色块，无黑条）
    expect(await pixel(out, BORDER + GUTTER + SIZE + SIZE / 2, BORDER + SIZE - 20)).toEqual([
      32, 96, 192,
    ]);
  });

  it("字幕条数多于格数 → 忽略多余并警告", async () => {
    const many = path.join(dir, "many.json");
    await writeFile(
      many,
      JSON.stringify([
        { index: 0, text: "甲" },
        { index: 9, text: "没有这格" },
        { index: 99, text: "也没有" },
      ]),
    );
    const out = path.join(dir, "many.png");
    const r = await run([
      "--input",
      grid,
      "--cells",
      cellsFile,
      "--captions",
      many,
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.j.warnings.map((w) => w.code)).toContain("E_PARTIAL_INPUT");
    expect(r.j.data.bars).toBe(1);
  });

  it("--cells 越界 → E_INVALID_OPTION 且 details.cell 指出是哪一格", async () => {
    const bad = path.join(dir, "bad-cells.json");
    await writeFile(
      bad,
      JSON.stringify({
        cells: [
          { index: 0, x: 0, y: 0, w: 100, h: 100 },
          { index: 1, x: 400, y: 400, w: 200, h: 200 },
        ],
        image: { width: W, height: W },
        source: "manual",
      }),
    );
    const r = await run(["--input", grid, "--cells", bad]);
    expect(r.code).toBe(2);
    expect(r.j.ok).toBe(false);
    expect(r.j.error?.code).toBe("E_INVALID_OPTION");
    expect(r.j.error?.details).toMatchObject({ cell: 1, option: "--cells" });
  });

  it("--cells 的 image 尺寸与实图不符 → 拒绝（cells 是为别的图生成的）", async () => {
    const other = path.join(dir, "other-cells.json");
    await writeFile(
      other,
      JSON.stringify({
        cells: [{ index: 0, x: 0, y: 0, w: 100, h: 100 }],
        image: { width: 2048, height: 2048 },
        source: "vision",
      }),
    );
    const r = await run(["--input", grid, "--cells", other]);
    expect(r.j.error?.code).toBe("E_INVALID_OPTION");
    expect(r.j.error?.details).toMatchObject({ reason: "image_size_mismatch" });
  });

  it("既无 --cells 也无 --captions → E_MISSING_ARGUMENT（提示用 doubao-grid-locate）", async () => {
    const r = await run(["--input", grid]);
    expect(r.code).toBe(2);
    expect(r.j.error?.code).toBe("E_MISSING_ARGUMENT");
    expect(r.j.error?.message).toContain("doubao-grid-locate");
  });

  it("目录输入 / 坏扩展名 / 缺 --input 都是用法错误（exit 2）", async () => {
    expect((await run(["--input", dir, "--captions", captionsFile])).j.error?.code).toBe(
      "E_INVALID_OPTION",
    );
    const gif = path.join(dir, "bad.gif");
    await writeFile(gif, "not an image");
    expect((await run(["--input", gif, "--captions", captionsFile])).j.error?.code).toBe(
      "E_INVALID_OPTION",
    );
    const missing = await run(["--captions", captionsFile]);
    expect(missing.j.error?.code).toBe("E_MISSING_ARGUMENT");
    expect(missing.code).toBe(2);
  });

  it("缺省输出走旁路 <name>.captioned.png，human 模式照样产出", async () => {
    const plain = await cli(
      ["media-grid-caption", "--input", grid, "--captions", captionsFile],
      {},
      dir,
    );
    expect(plain.code).toBe(0);
    const out = path.join(dir, "grid2x2.captioned.png");
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(W);
    expect(plain.stdout).not.toContain('"ok"');
  });
});
