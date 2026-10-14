import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAP_LIMIT,
  upscaleCellsToOriginal,
} from "../../plugins/doubao/lib/grid-image.mjs";
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
// 两侧用的是**不同**判据（薄边 vs 面积占比），所以必须有一组用例证明同一份几何不会两边打架；
// 最后那个 describe 钉的是这条链的**不变量**：产出侧修复窗口 ≤ 消费侧默认带子，
// 于是「产出侧有权发出的文件」永远不会被消费侧默认设置拒收（面积占比恒 ≤ 薄边，见 cells-geometry 头注）。

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

  it("findCellOverlaps 报出占比与薄边，分级只看占比（默认阈值与产出侧窗口同为 0.05）", () => {
    expect(DEFAULT_MAX_OVERLAP).toBe(0.05);
    const thinFound = findCellOverlaps(thin);
    expect(thinFound.total).toBe(1);
    expect(thinFound.severe).toHaveLength(0);
    expect(thinFound.minor[0]).toMatchObject({ ratio: 0.002, cells: [0, 1] });
    // 2.94% 是产出侧修复窗口（薄边 ≤5%）内的实测形态（S019 真实重叠 628x24 = 3.7% 同量级）
    // —— 旧默认 0.02 把它判成硬错误，于是兄弟命令的产物被拒收，管线断在这里
    const sliverFound = findCellOverlaps(sliver);
    expect(sliverFound.severe).toHaveLength(0);
    expect(sliverFound.minor[0]).toMatchObject({ ratio: 0.0294, thickness: 0.0294 });
    // 真误检（占较小格 33%）仍然落在硬拒那一档
    expect(findCellOverlaps(severe).severe[0].ratio).toBe(0.3333);
    expect(findCellOverlaps([]).total).toBe(0);
  });

  it("小重叠 → overlapError 返回 null（不报错）；大重叠 → 返回 E_INVALID_OPTION", () => {
    expect(overlapError(thin, { option: "--cells" })).toBeNull();
    // 修复窗口内的条状残渣（2.94%）默认不再拒收，只由调用方发警告
    expect(overlapError(sliver, { option: "--cells" })).toBeNull();
    const err = overlapError(severe, { option: "--cells" });
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ reason: "overlapping_cells", severe: 1, maxOverlap: 0.05 });
    expect(overlapError(thin, { option: "--cells", maxOverlap: 0 })).not.toBeNull();
    expect(overlapError(sliver, { option: "--cells", maxOverlap: 0.02 })).not.toBeNull();
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
  it("默认 0.05（与产出侧修复窗口同值）；小数照收；越界与非数字 E_INVALID_OPTION", () => {
    expect(parseGridCaptionArgs({ input: "a.png" }).maxOverlap).toBe(0.05);
    expect(parseGridCaptionArgs({ input: "a.png", maxOverlap: "0.02" }).maxOverlap).toBe(0.02);
    expect(parseGridCaptionArgs({ input: "a.png", maxOverlap: "0" }).maxOverlap).toBe(0);
    expect(parseGridCaptionArgs({ input: "a.png", maxOverlap: "1" }).maxOverlap).toBe(1);
    for (const bad of ["-1", "1.5", "abc", ""]) {
      const err = capture(() => parseGridCaptionArgs({ input: "a.png", maxOverlap: bad }));
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--max-overlap" });
    }
  });
});

// ---------- 管线不变量（§2「产出即可消费、零转换」的数值口径） ----------
// 不变量：**产出侧（doubao-grid-locate）跑完自己的修复 passes 之后有权发出的任何 cells JSON，
// 消费侧（media-grid-caption）在默认设置下必须收**（可以是警告，不能是 E_INVALID_OPTION）。
// 断链的实际形态：这里 0.02、那里 0.05 —— 真实页 S019 的 628x24px 重叠（占较小格 3.7%）
// 由 doubao 产出、又被 doubao 的窗口判为「可接受的取整残渣」，却被消费端默认设置硬拒。
describe("管线不变量：产出侧发得出来的文件，消费侧默认必须收", () => {
  const ACTUAL = { width: 2048, height: 2048 };
  const doc = (cells: unknown[]) => ({ cells, image: ACTUAL, source: "vision" });

  it("两侧阈值同源：消费侧默认带子 ≥ 产出侧修复窗口，且实现上就是同一个数", () => {
    expect(DEFAULT_MAX_OVERLAP).toBeGreaterThanOrEqual(DEFAULT_OVERLAP_LIMIT);
    expect(DEFAULT_MAX_OVERLAP).toBe(DEFAULT_OVERLAP_LIMIT);
  });

  // 面积占比 ≤ 薄边（较小格 S：ratio = (box.w/S.w)·(box.h/S.h)，另一因子恒 ≤ 1），
  // 所以产出侧窗口内的任意满宽条，无论有没有被切齐，消费侧都只会警告。取窗口边界附近扫一遍。
  it.each([0.004, 0.01, 0.02, 0.0294, 0.037, 0.049, 0.05])(
    "薄边=%s 的满宽条残渣（产出侧有权发出）在消费侧默认设置下被接受",
    (thinness) => {
      const h = 1000;
      const strip = Math.round(thinness * h);
      const cells = [
        { index: 0, x: 0, y: 0, w: 1000, h },
        { index: 1, x: 0, y: h - strip, w: 1000, h },
      ];
      const found = findCellOverlaps(cells);
      expect(found.severe).toHaveLength(0);
      expect(overlapError(cells, { option: "--cells" })).toBeNull();
      const ok = validateCells(doc(cells), { actual: ACTUAL });
      expect(ok.overlaps.minor.length).toBe(1);
    },
  );

  it("实测形状：S019 真实重叠 628x24px（占较小格 3.7%）→ 不再 E_INVALID_OPTION", () => {
    const cells = [
      { index: 2, x: 1413, y: 8, w: 628, h: 649 },
      { index: 5, x: 1412, y: 633, w: 630, h: 700 },
    ];
    const ok = validateCells(doc(cells), { actual: ACTUAL });
    expect(ok.overlaps.severe).toHaveLength(0);
    expect(ok.overlaps.minor[0]).toMatchObject({ w: 628, h: 24, ratio: 0.037 });
    // 老阈值下这份文件会被拒（钉住「谁把默认调小就回归」）
    expect(overlapError(cells, { option: "--cells", maxOverlap: 0.02 })).not.toBeNull();
  });

  it("最坏情况：落在产出侧窗口内、但切齐被主动放弃（削掉较大格 >25% 面积）的残渣 → 消费侧仍收", () => {
    const cells = [
      { index: 0, x: 0, y: 0, w: 1000, h: 40 }, // 较大面积 40000
      { index: 1, x: 0, y: 28, w: 40, h: 300 }, // 较小面积 12000，重叠 40x12
    ];
    const produced = repairCellOverlaps(cells, { limit: DEFAULT_OVERLAP_LIMIT });
    // 薄边 12/300 = 4% 在产出侧窗口内，但切这一刀要削掉较大格 30% 面积 → 产出侧不敢动，原样落盘
    expect(produced.cells).toEqual(cells);
    expect(produced.repaired).toBe(0);
    expect(produced.remaining).toBe(1);
    const found = findCellOverlaps(produced.cells);
    expect(found.minor[0]).toMatchObject({ ratio: 0.04 });
    expect(found.severe).toHaveLength(0);
    const canvas = { width: 1024, height: 512 };
    const ok = validateCells(
      { cells: produced.cells, image: canvas, source: "vision" },
      { actual: canvas },
    );
    expect(ok.cells).toHaveLength(2);
    expect(ok.overlaps.minor).toHaveLength(1);
  });

  it("产出侧切齐后的产物（重叠归零）自然被消费侧收下，且一条警告都不发", () => {
    const cells = [
      { index: 0, x: 0, y: 0, w: 1000, h: 1000 },
      { index: 1, x: 0, y: 950, w: 1000, h: 1000 }, // 满宽 50px 重叠 = 薄边 5%
    ];
    const produced = repairCellOverlaps(cells, { limit: DEFAULT_OVERLAP_LIMIT });
    expect(produced.repaired).toBe(1);
    expect(produced.remaining).toBe(0);
    const ok = validateCells(doc(produced.cells), { actual: ACTUAL });
    expect(ok.overlaps.total).toBe(0);
    expect(ok.overlaps.minor).toHaveLength(0);
  });

  it("真·坏重叠不放过：两格 30% 重合 → 默认仍然 E_INVALID_OPTION（details 点名两格）", () => {
    const coincident = [
      { index: 0, x: 0, y: 0, w: 1000, h: 1000 },
      { index: 1, x: 0, y: 300, w: 1000, h: 1000 }, // 重叠 1000x700 → 占较小格 70%
    ];
    const err = capture(() => validateCells(doc(coincident), { actual: ACTUAL }));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ reason: "overlapping_cells", cells: [0, 1], severe: 1 });
    // 用户自己的两条出路照旧有效
    expect(
      validateCells(doc(coincident), { actual: ACTUAL, allowOverlap: true }).overlaps.total,
    ).toBe(0);
    expect(
      validateCells(doc(coincident), { actual: ACTUAL, maxOverlap: 0.8 }).overlaps.minor,
    ).toHaveLength(1);
    // 实测坏例（33% / 22%）同样还在硬拒档
    expect(
      overlapError(
        [
          { index: 0, x: 0, y: 0, w: 300, h: 300 },
          { index: 1, x: 200, y: 0, w: 312, h: 300 },
        ],
        { option: "--cells" },
      ),
    ).not.toBeNull();
  });
});
