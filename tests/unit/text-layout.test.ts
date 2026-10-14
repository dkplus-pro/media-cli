import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  fallbackStartFontSize,
  LINE_HEIGHT_FACTOR,
  layoutCaption,
  layoutFallbackStack,
  MAX_LINES,
  MIN_FONT_SIZE,
  planAtFontSize,
  wrapLine,
} from "../../plugins/media-image/lib/text-layout.mjs";
import { measureText } from "../../plugins/media-image/lib/watermark.mjs";

// 自动字号 + 自动换行。测量走 watermark.mjs 的 measureText（真 sharp + librsvg），
// 所以这些断言就是「渲染出来放不放得下」的真值，不是纸面算术。
// 平均字宽按 CJK 等宽估算，拉丁串每字更窄，断言一律留实测余量。

const FONT = "sans-serif";
const STYLE = { font: FONT, color: "#FFFFFF", opacity: 1 };

const CJK = "春眠不觉晓处处闻啼鸟"; // 9 个全宽汉字
const LATIN = "nightlight"; // 10 个窄拉丁字母

function measurer(options = STYLE) {
  const cache = new Map<string, number>();
  return async (text: string, fontSize: number) => {
    const key = `${fontSize}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const { width } = await measureText(sharp, { ...options, text, fontSize });
    cache.set(key, width);
    return width;
  };
}

describe("text-layout 换行", () => {
  it("整行放得下就不折", async () => {
    const measure = measurer();
    const width = await measure(CJK, 30);
    const result = await wrapLine(measure, CJK, width + 1, 30);
    expect(result.lines).toEqual([CJK]);
    expect(result.overflow).toBe(false);
  });

  it("超宽按字符折行，每行实测宽度都不超过可用宽", async () => {
    const measure = measurer();
    const { lines, overflow } = await wrapLine(measure, CJK, 100, 30);
    expect(overflow).toBe(false);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(CJK);
    for (const line of lines) {
      expect(await measure(line, 30)).toBeLessThanOrEqual(100);
    }
  });

  it("已有的换行符先分段，不丢字也不加字", async () => {
    const measure = measurer();
    const { lines } = await wrapLine(measure, "第一段", 400, 28);
    expect(lines).toEqual(["第一段"]);
    const plan = await layoutCaption(sharp, {
      ...STYLE,
      text: "甲乙丙\n丁戊己",
      maxWidth: 400,
      maxHeight: 400,
      startFontSize: 28,
      padding: 6,
    });
    expect(plan.lines).toEqual(["甲乙丙", "丁戊己"]);
    expect(plan.truncated).toBe(false);
  });

  it("空文本 / 只有空白 → empty，不产黑条", async () => {
    const plan = await layoutCaption(sharp, {
      ...STYLE,
      text: "   \n  ",
      maxWidth: 200,
      maxHeight: 200,
      startFontSize: 24,
      padding: 12,
    });
    expect(plan).toMatchObject({ lines: [], empty: true, fits: false });
  });
});

describe("text-layout 自动字号与截断", () => {
  it("短文本用满起始字号", async () => {
    const plan = await layoutCaption(sharp, {
      ...STYLE,
      text: "好",
      maxWidth: 600,
      maxHeight: 300,
      startFontSize: 60,
      padding: 12,
    });
    expect(plan.fontSize).toBe(60);
    expect(plan.lines).toEqual(["好"]);
    expect(plan.barHeight).toBeCloseTo(60 * LINE_HEIGHT_FACTOR + 24, 1);
  });

  it("格子太小放不下时降字号，而不是一开始就截断", async () => {
    const plan = await layoutCaption(sharp, {
      ...STYLE,
      text: CJK,
      maxWidth: 260,
      maxHeight: 200,
      startFontSize: 60,
      padding: 8,
    });
    expect(plan.fontSize).toBeLessThan(60);
    expect(plan.truncated).toBe(false);
    expect(plan.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(plan.barHeight).toBeLessThanOrEqual(200);
  });

  it("字号下限 14：连最小字号都塞不下时按 4 行截断并以 … 收尾", async () => {
    const long = CJK.repeat(6);
    const plan = await layoutCaption(sharp, {
      ...STYLE,
      text: long,
      maxWidth: 60,
      maxHeight: 60,
      startFontSize: 40,
      padding: 4,
    });
    expect(plan.fontSize).toBe(MIN_FONT_SIZE);
    expect(plan.truncated).toBe(true);
    expect(plan.lines).toHaveLength(MAX_LINES);
    expect(plan.lines.at(-1)).toMatch(/…$/);
    // 截断是「保留前几行 + 末行省略号」，不是把整条字幕丢掉
    expect(long.startsWith(plan.lines[0])).toBe(true);
  });

  it("黑条高度受格高约束（maxHeight）而非只看行数", async () => {
    const measure = measurer();
    const wide = await planAtFontSize(measure, LATIN.repeat(3), {
      maxWidth: 400,
      maxHeight: 40,
      padding: 4,
      fontSize: 30,
      maxLines: MAX_LINES,
    });
    expect(wide.fits).toBe(false);
    const narrow = await planAtFontSize(measure, LATIN, {
      maxWidth: 400,
      maxHeight: 200,
      padding: 4,
      fontSize: 30,
      maxLines: MAX_LINES,
    });
    expect(narrow.fits).toBe(true);
  });
});

describe("兜底版式的整条字幕栈", () => {
  it("字号按整图宽收档（2048 宽 → 43，不再是最短边 1/24 的 85）", () => {
    expect(fallbackStartFontSize(2048, 2048)).toBe(43);
    expect(fallbackStartFontSize(512, 512)).toBe(18);
    expect(fallbackStartFontSize(120, 4000)).toBe(MIN_FONT_SIZE);
  });

  it("N 条字幕逐条换行后堆进同一条黑条，行数是各条之和", async () => {
    const stack = await layoutFallbackStack(sharp, {
      texts: ["第一句", "第二句", "第三句很长".repeat(2)],
      width: 900,
      height: 900,
      ...STYLE,
      padding: 12,
    });
    expect(stack.blocks).toHaveLength(3);
    expect(stack.lines).toBe(
      stack.blocks.reduce((n: number, b: { lines: string[] }) => n + b.lines.length, 0),
    );
    expect(stack.lines).toBeGreaterThanOrEqual(3);
    expect(stack.barHeight).toBeCloseTo(stack.lines * stack.lineHeight + 24, 1);
    expect(stack.truncated).toBe(false);
  });

  it("forced 字号生效；过长时逐条截断到 4 行并标记 truncated", async () => {
    const stack = await layoutFallbackStack(sharp, {
      texts: [CJK.repeat(8)],
      width: 300,
      height: 300,
      ...STYLE,
      padding: 6,
      fontSize: 40,
    });
    expect(stack.fontSize).toBe(40);
    expect(stack.truncated).toBe(true);
    expect(stack.blocks[0].lines.length).toBeLessThanOrEqual(MAX_LINES);
  });
});
