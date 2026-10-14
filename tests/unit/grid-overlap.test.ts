import { describe, expect, it } from "vitest";
import { upscaleCellsToOriginal } from "../../plugins/doubao/lib/grid-image.mjs";
import { repairCellOverlaps } from "../../plugins/doubao/lib/grid-overlap.mjs";
import {
  DEFAULT_MAX_OVERLAP,
  findCellOverlaps,
  overlapError,
  overlapWarningText,
} from "../../plugins/media-image/lib/cells-geometry.mjs";
import { validateCells } from "../../plugins/media-image/lib/cells-io.mjs";
import { parseGridCaptionArgs } from "../../plugins/media-image/lib/cells-options.mjs";

// Issue 1 的两侧口径钉在一起测：产出侧（doubao-grid-locate）把放大取整产生的薄条重叠切齐，
// 消费侧（media-grid-caption）把「占较小格面积 ≤ --max-overlap」的重叠降级为警告。
// 两侧用的是**不同**判据（薄边 vs 面积占比），所以必须有一组用例证明同一份几何不会两边打架。

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

function capture(fn: () => unknown): CliErr {
  try {
    fn();
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

function overlapsOf(cells: { index: number; x: number; y: number; w: number; h: number }[]) {
  return findCellOverlaps(cells).total;
}

describe("产出侧：放大后的薄条重叠就地切齐（grid-overlap）", () => {
  // 实测形态：真实 2048x2048 页两格重叠 628x24px（薄边 24/700 ≈ 3.4% ≤ 5%）
  it("薄条条状重叠被切齐，且只在重叠区里切（其余几何一字未动）", () => {
    const input = [
      { index: 0, x: 0, y: 0, w: 660, h: 700 },
      { index: 1, x: 32, y: 676, w: 628, h: 700 },
    ];
    const out = repairCellOverlaps(input);
    expect(out.repaired).toBe(1);
    expect(out.remaining).toBe(0);
    expect(overlapsOf(out.cells)).toBe(0);
    // 被切的只能是较大的第 0 格，且削掉的正好是重叠那 24px（不越界、不改动 x/w）
    expect(out.cells[0]).toMatchObject({ x: 0, y: 0, w: 660, h: 676 });
    expect(out.cells[1]).toEqual(input[1]);
  });

  it("纯函数：入参数组不被改动", () => {
    const input = [
      { index: 0, x: 0, y: 0, w: 1024, h: 1024 },
      { index: 1, x: 1022, y: 0, w: 1024, h: 1024 },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    repairCellOverlaps(input);
    expect(input).toEqual(snapshot);
  });

  it("放大取整（±1px）的形态被修掉：sx=0.765625 下 1 小图像素 → 1 原图像素", () => {
    // 模拟模型给 cell1 的 x 比公共边偏了 1 小图像素 → 放大后 1px 重叠
    const vision = [
      { index: 0, x: 0, y: 0, w: 1024, h: 392 },
      { index: 1, x: 1023, y: 0, w: 545, h: 392 },
    ];
    const upscaled = upscaleCellsToOriginal(vision, 0.765625, 0.765625, {
      width: 2048,
      height: 1024,
    });
    expect(upscaled.clamped).toBeGreaterThanOrEqual(0); // 内收与修复是两件事，这里只要求不越界
    expect(overlapsOf(upscaled.cells)).toBeGreaterThan(0);
    const repaired = repairCellOverlaps(upscaled.cells);
    expect(repaired.repaired).toBeGreaterThan(0);
    expect(overlapsOf(repaired.cells)).toBe(0);
    for (const cell of repaired.cells) {
      expect(cell.w).toBeGreaterThan(0);
      expect(cell.h).toBeGreaterThan(0);
      expect(cell.x + cell.w).toBeLessThanOrEqual(2048);
      expect(cell.y + cell.h).toBeLessThanOrEqual(1024);
    }
  });

  it("模型真的把两格框重了（薄边 >5%）→ 不硬修，原样留给消费侧并计入 remaining", () => {
    const big = [
      { index: 0, x: 0, y: 0, w: 300, h: 300 },
      { index: 1, x: 200, y: 0, w: 312, h: 300 }, // 重叠 100x300，薄边 33%
    ];
    const out = repairCellOverlaps(big);
    expect(out.repaired).toBe(0);
    expect(out.remaining).toBe(1);
    expect(out.cells).toEqual(big);
  });

  it("一格被完全包住（切齐要削掉 >25% 面积）→ 不修；本来不相交 → 一格都不动", () => {
    const contained = repairCellOverlaps([
      { index: 0, x: 0, y: 0, w: 600, h: 600 },
      { index: 1, x: 100, y: 100, w: 100, h: 100 },
    ]);
    expect(contained.repaired).toBe(0);
    expect(contained.remaining).toBe(1);
    const clean = repairCellOverlaps([
      { index: 0, x: 0, y: 0, w: 300, h: 300 },
      { index: 1, x: 300, y: 0, w: 300, h: 300 }, // 只共边，不算重叠
    ]);
    expect(clean.repaired).toBe(0);
    expect(clean.remaining).toBe(0);
    expect(clean.cells[1]).toMatchObject({ x: 300 });
  });

  it("链式重叠（一格同时压着两格）会被多轮收敛；limit=0 关掉修复", () => {
    const chained = repairCellOverlaps([
      { index: 0, x: 0, y: 0, w: 680, h: 660 },
      { index: 1, x: 660, y: 0, w: 680, h: 660 },
      { index: 2, x: 0, y: 640, w: 1340, h: 680 },
    ]);
    expect(chained.repaired).toBe(2);
    expect(chained.remaining).toBe(0);
    const off = repairCellOverlaps(
      [
        { index: 0, x: 0, y: 0, w: 660, h: 700 },
        { index: 1, x: 32, y: 676, w: 628, h: 700 },
      ],
      { limit: 0 },
    );
    expect(off.repaired).toBe(0);
    expect(off.remaining).toBe(1);
  });
});

describe("消费侧：重叠按占较小格面积分级（cells-geometry）", () => {
  const sliver = [
    { index: 0, x: 0, y: 0, w: 680, h: 660 },
    { index: 1, x: 660, y: 0, w: 680, h: 660 }, // 与第 0 格重叠 20x660 = 占较小格 3%
  ];
  const thin = [
    { index: 0, x: 0, y: 0, w: 1024, h: 1024 },
    { index: 1, x: 1022, y: 0, w: 1024, h: 1024 }, // 重叠 2x1024 = 占较小格 0.2%
  ];
  const severe = [
    { index: 0, x: 0, y: 0, w: 300, h: 300 },
    { index: 1, x: 200, y: 0, w: 312, h: 300 }, // 100x300 = 占较小格 33%
  ];

  it("findCellOverlaps 报出占比与薄边，分级只看占比（默认阈值 0.02）", () => {
    expect(DEFAULT_MAX_OVERLAP).toBe(0.02);
    const thinFound = findCellOverlaps(thin);
    expect(thinFound.total).toBe(1);
    expect(thinFound.severe).toHaveLength(0);
    expect(thinFound.minor[0]).toMatchObject({ ratio: 0.002, cells: [0, 1] });
    // 3% 超过 2% → 落在硬拒那一档（这正是产出侧要负责切齐的形态）
    const sliverFound = findCellOverlaps(sliver);
    expect(sliverFound.severe[0]).toMatchObject({ ratio: 0.0294, thickness: 0.0294 });
    expect(sliverFound.minor).toHaveLength(0);
    expect(findCellOverlaps(severe).severe[0].ratio).toBe(0.3333);
    expect(findCellOverlaps([]).total).toBe(0);
  });

  it("小重叠 → overlapError 返回 null（不报错）；大重叠 → 返回 E_INVALID_OPTION", () => {
    expect(overlapError(thin, { option: "--cells" })).toBeNull();
    const err = overlapError(severe, { option: "--cells" });
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ reason: "overlapping_cells", severe: 1, maxOverlap: 0.02 });
    expect(overlapError(thin, { option: "--cells", maxOverlap: 0 })).not.toBeNull();
    expect(overlapError(severe, { option: "--cells", maxOverlap: 0.5 })).toBeNull();
    expect(overlapError(severe, { option: "--cells", allowOverlap: true })).toBeNull();
  });

  // 实测坑：旧文案让用户「用 doubao-grid-locate 重跑」——那份 JSON 就是它刚产的，原地打转
  it("错误文案不许指向产出这份文件的命令，只给能落地的三条出路", () => {
    const message = overlapError(severe, { option: "--cells" }).message;
    expect(message).not.toContain("doubao-grid-locate");
    expect(message).toContain("--allow-overlap");
    expect(message).toContain("编辑");
    expect(message).toContain("--cols/--rows");
    const warning = overlapWarningText("--cells", findCellOverlaps(thin).minor);
    expect(warning).not.toContain("doubao-grid-locate");
    expect(warning).toContain("--max-overlap");
  });

  it("validateCells：小重叠带 overlaps.minor 返回（不抛），大重叠抛，--allow-overlap 连 minor 都清空", () => {
    const actual = { width: 2048, height: 2048 };
    const doc = (cells: unknown[]) => ({ cells, image: actual, source: "vision" });
    const minor = validateCells(doc(thin), { actual });
    expect(minor.cells).toHaveLength(2);
    expect(minor.overlaps.minor).toHaveLength(1);
    expect(minor.overlaps.severe).toHaveLength(0);
    const err = capture(() => validateCells(doc(severe), { actual }));
    expect(err.code).toBe("E_INVALID_OPTION");
    const allowed = validateCells(doc(severe), { actual, allowOverlap: true });
    expect(allowed.overlaps.minor).toHaveLength(0);
    expect(allowed.overlaps.total).toBe(0);
    const loosened = validateCells(doc(severe), { actual, maxOverlap: 0.5 });
    expect(loosened.overlaps.minor).toHaveLength(1);
  });
});

describe("--max-overlap 选项落值", () => {
  it("默认 0.02；小数照收；越界与非数字 E_INVALID_OPTION", () => {
    expect(parseGridCaptionArgs({ input: "a.png" }).maxOverlap).toBe(0.02);
    expect(parseGridCaptionArgs({ input: "a.png", maxOverlap: "0.05" }).maxOverlap).toBe(0.05);
    expect(parseGridCaptionArgs({ input: "a.png", maxOverlap: "0" }).maxOverlap).toBe(0);
    expect(parseGridCaptionArgs({ input: "a.png", maxOverlap: "1" }).maxOverlap).toBe(1);
    for (const bad of ["-1", "1.5", "abc", ""]) {
      const err = capture(() => parseGridCaptionArgs({ input: "a.png", maxOverlap: bad }));
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--max-overlap" });
    }
  });
});
