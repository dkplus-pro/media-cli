import { describe, expect, it } from "vitest";
import { normalizeVisionCells } from "../../plugins/doubao/lib/grid-schema.mjs";
import {
  buildEqualCells,
  describePartialInput,
  findCellOverlaps,
  mergeCaptions,
  parseJsonDocument,
  SOURCE_NONE,
  validateCaptions,
  validateCells,
} from "../../plugins/media-image/lib/cells-io.mjs";
import { parseGridCaptionArgs } from "../../plugins/media-image/lib/cells-options.mjs";

// §2 的 cells schema 是冻结契约：这里逐条钉住 5 条校验规则 + F3 的重叠关，
// 顺便钉住「视觉模型常见毛病的有记录宽容」（归一化坐标自动放大 + notes），两者是一套 schema 的两面。

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

const ACTUAL = { width: 1024, height: 1024 };

const doc = (cells: unknown[], extra: Record<string, unknown> = {}) => ({
  cells,
  image: { width: 1024, height: 1024 },
  source: "manual",
  ...extra,
});

const CELL = { index: 0, x: 0, y: 0, w: 512, h: 512 };

describe("cells JSON 校验（§2 五条规则）", () => {
  it("规则 0：合法文档原样收下，并保留可选样式字段与 source", () => {
    const result = validateCells(
      doc([{ ...CELL, text: "第一格", fontSize: 42, align: "left", position: "top" }]),
      { actual: ACTUAL },
    );
    expect(result.cells).toEqual([
      {
        index: 0,
        x: 0,
        y: 0,
        w: 512,
        h: 512,
        text: "第一格",
        fontSize: 42,
        align: "left",
        position: "top",
      },
    ]);
    expect(result.source).toBe("manual");
  });

  it("规则 1：cells 必须是非空数组", () => {
    const err = capture(() => validateCells(doc([]), { actual: ACTUAL }));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ reason: "empty_cells" });
    expect(capture(() => validateCells(doc(undefined), { actual: ACTUAL })).details).toMatchObject({
      reason: "empty_cells",
    });
  });

  it("规则 2：x/y/w/h 必须是有限整数，w/h 必须为正", () => {
    for (const bad of [
      { index: 0, x: 0, y: 0, w: 0, h: 10 },
      { index: 0, x: 0, y: 0, w: -5, h: 10 },
      { index: 0, x: 0.5, y: 0, w: 10, h: 10 },
      { index: 0, x: 0, y: Number.NaN, w: 10, h: 10 },
      { index: 0, x: "0", y: 0, w: 10, h: 10 },
    ]) {
      const err = capture(() => validateCells(doc([bad]), { actual: ACTUAL }));
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details?.cell).toBe(0);
    }
  });

  it("规则 3：越界即拒，不静默裁剪", () => {
    const err = capture(() =>
      validateCells(doc([{ index: 0, x: 1000, y: 1000, w: 100, h: 100 }]), { actual: ACTUAL }),
    );
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ cell: 0, option: "--cells" });
    expect(err.message).toContain("越界");
    // 贴边但不越界是合法的
    expect(
      validateCells(doc([{ index: 0, x: 0, y: 0, w: 1024, h: 1024 }]), { actual: ACTUAL }).cells,
    ).toHaveLength(1);
  });

  it("规则 4：index 必须唯一、是非负整数", () => {
    const dup = capture(() =>
      validateCells(
        doc([
          { ...CELL, index: 3 },
          { ...CELL, index: 3, x: 10 },
        ]),
        { actual: ACTUAL },
      ),
    );
    expect(dup.details).toMatchObject({ cell: 3 });
    expect(dup.message).toContain("重复");
    for (const bad of [
      { ...CELL, index: -1 },
      { ...CELL, index: 0.5 },
      { ...CELL, index: undefined },
    ]) {
      expect(capture(() => validateCells(doc([bad]), { actual: ACTUAL })).details).toMatchObject({
        cell: 0,
      });
    }
  });

  it("规则 5：image 尺寸与实际解码尺寸不符即拒（cells 是为别的图生成的）", () => {
    const err = capture(() => validateCells(doc([CELL]), { actual: { width: 512, height: 512 } }));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({
      reason: "image_size_mismatch",
      cells: { width: 1024, height: 1024 },
      actual: { width: 512, height: 512 },
    });
    expect(
      capture(() => validateCells(doc([CELL], { image: {} }), { actual: ACTUAL })).details,
    ).toMatchObject({ reason: "missing_image_size" });
  });

  it("样式字段非法也拒（不猜用户意图），source 缺失按 manual 处理", () => {
    expect(
      capture(() => validateCells(doc([{ ...CELL, align: "middle" }]), { actual: ACTUAL })).details,
    ).toMatchObject({ cell: 0 });
    expect(
      capture(() => validateCells(doc([{ ...CELL, fontSize: 3 }]), { actual: ACTUAL })).message,
    ).toContain("fontSize");
    expect(validateCells(doc([CELL], { source: "nope" }), { actual: ACTUAL }).source).toBe(
      "manual",
    );
  });

  it("--cells 顶层给成数组（那是 --captions 的形态）→ 明确提示改用 --captions", () => {
    const err = capture(() => validateCells([{ index: 0 }], { actual: ACTUAL }));
    expect(err.details).toMatchObject({ reason: "not_object" });
    expect(parseJsonDocument("[1,2]", "--captions", { allowArray: true })).toEqual([1, 2]);
    expect(capture(() => parseJsonDocument("[1,2]", "--cells")).details).toMatchObject({
      reason: "not_json",
    });
    expect(capture(() => parseJsonDocument("not json", "--cells")).code).toBe("E_INVALID_OPTION");
  });
});

describe("--captions 列表与合并", () => {
  it("缺 index 按下标补，重复 index / 非字符串 text 即拒", () => {
    const items = validateCaptions([{ text: "甲" }, { index: 5, text: "乙" }], {
      option: "--captions",
    });
    expect(items).toEqual([
      { index: 0, text: "甲" },
      { index: 5, text: "乙" },
    ]);
    expect(
      capture(() =>
        validateCaptions([
          { index: 0, text: "a" },
          { index: 0, text: "b" },
        ]),
      ).code,
    ).toBe("E_INVALID_OPTION");
    expect(capture(() => validateCaptions([{ index: 0 }])).message).toContain("text");
    expect(capture(() => validateCaptions({ nope: 1 })).details).toMatchObject({
      reason: "not_array",
    });
  });

  it("合并按 index 对齐：--captions 覆盖同格文本，多余的计入 droppedCaptions", () => {
    const cells = [
      { index: 0, x: 0, y: 0, w: 10, h: 10, text: "旧文本" },
      { index: 1, x: 20, y: 0, w: 10, h: 10 },
    ];
    const merged = mergeCaptions(cells, [
      { index: 1, text: "新文本" },
      { index: 9, text: "没有这格" },
    ]);
    expect(merged.cells).toEqual([
      { index: 0, x: 0, y: 0, w: 10, h: 10, text: "旧文本" },
      { index: 1, x: 20, y: 0, w: 10, h: 10, text: "新文本" },
    ]);
    expect(merged.withText).toBe(2);
    expect(merged.droppedCaptions).toBe(1);
    expect(mergeCaptions([{ index: 0, x: 0, y: 0, w: 1, h: 1 }], []).withText).toBe(0);
  });
});

describe("格子重叠校验（F3：§2 之外的第六道关）", () => {
  // 实测坏例：视觉模型把第 0/1 格算成重叠 112x550，另有一条 120x250 的碎片同时压着两格，
  // 旧代码照单全收 → 同一格里画了两条字幕，其中一条悬浮在格子中间
  const overlapping = [
    { index: 0, x: 0, y: 0, w: 512, h: 512 },
    { index: 1, x: 400, y: 0, w: 512, h: 512 },
    { index: 2, x: 390, y: 40, w: 120, h: 250 },
  ];

  it("findCellOverlaps 认出每一组重叠及重叠尺寸", () => {
    const found = findCellOverlaps(overlapping);
    expect(found.total).toBe(3); // 0-1、0-2、1-2
    expect(found.shown.map((p) => p.cells)).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
    expect(found.shown[0]).toMatchObject({ w: 112, h: 512 });
    expect(found.shown[1]).toMatchObject({ w: 120, h: 250 });
    expect(findCellOverlaps([...overlapping.slice(0, 1)]).total).toBe(0);
  });

  it("只共边/共点不算重叠（规则宫格天然贴边）", () => {
    expect(
      findCellOverlaps([
        { index: 0, x: 0, y: 0, w: 512, h: 512 },
        { index: 1, x: 512, y: 0, w: 512, h: 512 },
        { index: 2, x: 0, y: 512, w: 512, h: 512 },
      ]).total,
    ).toBe(0);
    expect(
      validateCells(
        doc([
          { index: 0, x: 0, y: 0, w: 512, h: 512 },
          { index: 1, x: 512, y: 0, w: 512, h: 512 },
        ]),
        { actual: ACTUAL },
      ).cells,
    ).toHaveLength(2);
  });

  it("重叠 → E_INVALID_OPTION，details 点名是哪两格", () => {
    const err = capture(() => validateCells(doc(overlapping), { actual: ACTUAL }));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({
      option: "--cells",
      reason: "overlapping_cells",
      cells: [0, 1],
      total: 3,
    });
    expect(err.message).toContain("第 0 格与第 1 格重叠");
    expect(err.message).toContain("--allow-overlap");
  });

  it("--allow-overlap 显式放行（刻意的分层版式仍然画得出来）", () => {
    const ok = validateCells(doc(overlapping), { actual: ACTUAL, allowOverlap: true });
    expect(ok.cells).toHaveLength(3);
    expect(findCellOverlaps(ok.cells).total).toBe(3);
  });
});

describe("字幕与格数的部分输入（F6：只许一条自洽的警告）", () => {
  const cells = [
    { index: 0, x: 0, y: 0, w: 10, h: 10 },
    { index: 1, x: 20, y: 0, w: 10, h: 10 },
    { index: 2, x: 40, y: 0, w: 10, h: 10 },
    { index: 3, x: 60, y: 0, w: 10, h: 10 },
  ];

  it("4 格 + 3 条有文本 + 1 条 index 对不上 → 一条警告同时说清两件事", () => {
    const merged = mergeCaptions(cells, [
      { index: 0, text: "甲" },
      { index: 1, text: "乙" },
      { index: 2, text: "丙" },
      { index: 7, text: "没有这格" },
    ]);
    expect(merged.withText).toBe(3);
    expect(merged.cellCount).toBe(4);
    expect(merged.missingCells).toEqual([3]);
    expect(merged.droppedIndexes).toEqual([7]);
    expect(merged.droppedCaptions).toBe(1);
    const message = describePartialInput(merged);
    expect(message).not.toBeNull();
    expect(message).toContain("4 格里有 1 格没有字幕文本（index 3");
    expect(message).toContain("1 条字幕找不到对应格（index 7");
    // 老 bug 的两句互相矛盾的话都不许再出现
    expect(message).not.toContain("少于格数");
    expect(message).not.toContain("多于格数");
  });

  it("文本与格子刚好对齐 → null（不发警告）", () => {
    const merged = mergeCaptions(
      cells,
      cells.map((c) => ({ index: c.index, text: "字" })),
    );
    expect(describePartialInput(merged)).toBeNull();
    expect(mergeCaptions(cells, []).withText).toBe(0);
    expect(describePartialInput(mergeCaptions(cells, []))).toContain("4 格没有字幕文本");
  });

  it("§2 的 source 枚举含兜底值 none", () => {
    expect(SOURCE_NONE).toBe("none");
  });
});

describe("--cols/--rows 等分与选项解析", () => {
  it("等分切格铺满画布且不重叠，index 行优先", () => {
    const cells = buildEqualCells(1000, 700, 4, 3);
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ index: 0, x: 0, y: 0, w: 250, h: 233 });
    expect(cells[11]).toEqual({ index: 11, x: 750, y: 467, w: 250, h: 233 });
    for (const cell of cells) {
      expect(cell.w).toBeGreaterThan(0);
      expect(cell.h).toBeGreaterThan(0);
    }
    expect(cells.at(-1).y + cells.at(-1).h).toBe(700);
    expect(cells.at(-1).x + cells.at(-1).w).toBe(1000);
  });

  it("默认值：sans-serif / #FFFFFF / 0.75 / padding 12 / bottom / 检测开启 / 重叠按 0.02 分级", () => {
    expect(parseGridCaptionArgs({ input: "a.png" })).toMatchObject({
      input: "a.png",
      cellsPath: null,
      captionsPath: null,
      division: null,
      locate: true,
      font: "sans-serif",
      fontSize: null,
      textColor: "#FFFFFF",
      opacity: 0.75,
      padding: 12,
      position: "bottom",
      bgTol: 24,
      minGutter: 3,
      allowOverlap: false,
      maxOverlap: 0.02,
      output: null,
    });
    expect(parseGridCaptionArgs({ input: "a.png", allowOverlap: true }).allowOverlap).toBe(true);
    // 非布尔（--allow-overlap 是开关，不带值）：只认 true
    expect(parseGridCaptionArgs({ input: "a.png", allowOverlap: "no" }).allowOverlap).toBe(false);
  });

  it("--no-locate 关掉本地检测；--cols 单给 → E_INVALID_OPTION", () => {
    expect(parseGridCaptionArgs({ input: "a.png", locate: false }).locate).toBe(false);
    const err = capture(() => parseGridCaptionArgs({ input: "a.png", cols: "3" }));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ option: "--rows" });
    expect(parseGridCaptionArgs({ input: "a.png", cols: "3", rows: "3" }).division).toEqual({
      cols: 3,
      rows: 3,
    });
  });

  it("选项边界：padding/flat-tol/min-gutter/position/text-color 非法值各自被拒", () => {
    expect(capture(() => parseGridCaptionArgs({ padding: "-1" })).details).toMatchObject({
      option: "--padding",
    });
    expect(capture(() => parseGridCaptionArgs({ flatTol: "999" })).details).toMatchObject({
      option: "--flat-tol",
    });
    expect(capture(() => parseGridCaptionArgs({ minGutter: "abc" })).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseGridCaptionArgs({ position: "left" })).details).toMatchObject({
      option: "--position",
    });
    expect(
      capture(() => parseGridCaptionArgs({ textColor: 'red"/ onload="x' })).details,
    ).toMatchObject({ option: "--text-color" });
    expect(parseGridCaptionArgs({ textColor: "rgb(255,255,255)" }).textColor).toBe(
      "rgb(255,255,255)",
    );
  });
});

describe("视觉模型输出的有记录宽容（doubao grid-schema）", () => {
  const raw = (cells: unknown[], image?: { width: number; height: number }) => ({
    cells,
    ...(image ? { image } : {}),
  });

  it("归一化坐标（全部 ≤1.5）自动放大为像素并写进 notes", () => {
    const result = normalizeVisionCells(
      raw([{ index: 0, x: 0, y: 0, w: 0.5, h: 0.334 }], { width: 1024, height: 1024 }),
      { actualWidth: 2048, actualHeight: 2048 },
    );
    expect(result.cells[0]).toEqual({ index: 0, x: 0, y: 0, w: 1024, h: 684 });
    expect(result.image).toEqual({ width: 2048, height: 2048 });
    expect(result.source).toBe("vision");
    expect(result.notes.join(" ")).toContain("归一化");
  });

  it("模型自报画布与真实尺寸不符 → 按比例换算 + notes", () => {
    const result = normalizeVisionCells(
      raw([{ index: 0, x: 0, y: 0, w: 500, h: 250 }], { width: 1000, height: 1000 }),
      { actualWidth: 2000, actualHeight: 2000 },
    );
    expect(result.cells[0]).toMatchObject({ w: 1000, h: 500 });
    expect(result.notes.join(" ")).toContain("换算");
  });

  it("小幅越界内收并记 notes；严重越界拒收（绝不静默裁剪）", () => {
    const slight = normalizeVisionCells(
      raw([{ index: 0, x: 0, y: 0, w: 2052, h: 2049 }], { width: 2048, height: 2048 }),
      { actualWidth: 2048, actualHeight: 2048 },
    );
    expect(slight.cells[0]).toMatchObject({ w: 2048, h: 2048 });
    expect(slight.notes.join(" ")).toContain("内收");
    const err = capture(() =>
      normalizeVisionCells(
        raw([{ index: 1, x: 1900, y: 0, w: 400, h: 100 }], { width: 2048, height: 2048 }),
        { actualWidth: 2048, actualHeight: 2048 },
      ),
    );
    expect(err.code).toBe("E_PROVIDER_ERROR");
    expect(err.details).toMatchObject({ reason: "out_of_bounds_cell", cell: 0 });
  });

  it("index 缺失/重复 → 按返回顺序重编 0..n-1 并记 notes；合法 index 原样保留", () => {
    const fixed = normalizeVisionCells(
      raw([
        { index: 1, x: 0, y: 0, w: 10, h: 10 },
        { index: 1, x: 20, y: 0, w: 10, h: 10 },
      ]),
      { actualWidth: 100, actualHeight: 100 },
    );
    expect(fixed.cells.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    expect(fixed.notes.join(" ")).toContain("重编");
    const kept = normalizeVisionCells(
      raw([
        { index: 1, x: 0, y: 0, w: 10, h: 10 },
        { index: 0, x: 20, y: 0, w: 10, h: 10 },
      ]),
      { actualWidth: 100, actualHeight: 100 },
    );
    expect(kept.cells[0].index).toBe(1);
    expect(kept.notes).toEqual([]);
  });

  it("cells 缺失或宽高非正 → E_PROVIDER_ERROR（不是 E_INVALID_OPTION：错在模型不在用户）", () => {
    expect(capture(() => normalizeVisionCells({}, {})).code).toBe("E_PROVIDER_ERROR");
    const err = capture(() =>
      normalizeVisionCells(raw([{ index: 0, x: 0, y: 0, w: 0, h: 10 }]), {
        actualWidth: 100,
        actualHeight: 100,
      }),
    );
    expect(err.details).toMatchObject({ reason: "invalid_vision_cells", cell: 0 });
  });

  it("数字写成字符串也能吃下，脏样式字段丢弃但不弃整格", () => {
    const result = normalizeVisionCells(
      raw([{ index: 0, x: "10", y: "20", w: "30", h: "40", align: "middle", text: "  甲  " }]),
      { actualWidth: 100, actualHeight: 100 },
    );
    expect(result.cells[0]).toEqual({ index: 0, x: 10, y: 20, w: 30, h: 40, text: "  甲  " });
  });
});
