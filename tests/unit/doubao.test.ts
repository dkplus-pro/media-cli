import { describe, expect, it } from "vitest";
import { getConfig } from "../../plugins/doubao/lib/config.mjs";
import { buildPrompt, parseOptions } from "../../plugins/doubao/lib/options.mjs";
import { parseSilences, planSegments } from "../../plugins/doubao/lib/segments.mjs";
import { buildSrt, countCues, formatSrtTime, joinText } from "../../plugins/doubao/lib/srt.mjs";

describe("doubao 分段规划", () => {
  it("parseSilences 配对 start/end 并丢弃残缺尾巴", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 10.5",
      "[silencedetect @ 0x1] silence_end: 11.25 | silence_duration: 0.75",
      "[silencedetect @ 0x1] silence_start: 20.0",
    ].join("\n");
    expect(parseSilences(stderr)).toEqual([{ start: 10.5, end: 11.25 }]);
    expect(parseSilences("")).toEqual([]);
  });

  it("不超过硬上限的音频整段送模型", () => {
    expect(planSegments({ durationSec: 40, targetSec: 30, maxSec: 45 })).toEqual([
      { start: 0, end: 40 },
    ]);
  });

  it("切点落在静音中点，避免切在词中间", () => {
    const silences = [
      { start: 30, end: 31 },
      { start: 70, end: 71 },
    ];
    const segs = planSegments({ durationSec: 100, silences, targetSec: 30, maxSec: 45 });
    expect(segs[0]).toEqual({ start: 0, end: 30.5 });
    expect(segs[1]).toEqual({ start: 30.5, end: 70.5 });
    expect(segs[2]).toEqual({ start: 70.5, end: 100 });
  });

  it("无静音可用时按硬上限定长切，最后一段不短于 2s", () => {
    const segs = planSegments({ durationSec: 100, targetSec: 30, maxSec: 45 });
    expect(segs.map((s) => s.end)).toEqual([45, 90, 100]);
    expect(segs.every((s) => s.end - s.start >= 2)).toBe(true);
  });

  it("时长非法返回空数组（调用方据此报无可转写内容）", () => {
    expect(planSegments({ durationSec: 0 })).toEqual([]);
  });
});

describe("doubao SRT 组装", () => {
  it("formatSrtTime 毫秒补零且不产生负时间", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(3661.5)).toBe("01:01:01,500");
    expect(formatSrtTime(-1)).toBe("00:00:00,000");
  });

  it("段边界精确、段内按字数比例摊时间，序号连续", () => {
    const srt = buildSrt([
      { start: 0, end: 10, text: "四个字啊\n六个字一句话" },
      { start: 10, end: 12, text: "短句" },
    ]);
    const cues = srt.trim().split("\n\n");
    expect(cues).toHaveLength(3);
    expect(cues[0].startsWith("1\n00:00:00,000 -->")).toBe(true);
    // 4 字 vs 6 字 → 10s 段内按 4:6 分配
    expect(cues[0]).toContain("00:00:04,000");
    expect(cues[1]).toContain("--> 00:00:10,000");
    expect(cues[2].startsWith("3\n00:00:10,000 --> 00:00:12,000")).toBe(true);
    expect(countCues(srt)).toBe(3);
  });

  it("空行与全空输入不产生字幕块", () => {
    expect(buildSrt([{ start: 0, end: 5, text: "  \n \n" }])).toBe("");
    expect(
      joinText([
        { start: 0, end: 5, text: "a\n b " },
        { start: 5, end: 6, text: "c" },
      ]),
    ).toBe("a\nb\nc");
  });
});

describe("doubao 选项与配置", () => {
  it("默认值与越界夹取", () => {
    expect(parseOptions({})).toMatchObject({
      format: "srt",
      segmentSeconds: 30,
      maxSegmentSeconds: 45,
      concurrency: 4,
      language: "auto",
    });
    expect(parseOptions({ segmentSeconds: "300" }).segmentSeconds).toBe(120);
    expect(parseOptions({ segmentSeconds: "300" }).maxSegmentSeconds).toBe(120);
    expect(parseOptions({ concurrency: "99" }).concurrency).toBe(8);
  });

  it("--format 非法 → E_INVALID_OPTION；--concurrency 非数字 → E_INVALID_OPTION", () => {
    expect(() => parseOptions({ format: "vtt" })).toThrow(
      expect.objectContaining({ code: "E_INVALID_OPTION" }),
    );
    expect(() => parseOptions({ concurrency: "abc" })).toThrow(
      expect.objectContaining({ code: "E_INVALID_OPTION" }),
    );
  });

  it("prompt 基底固定，language/prompt 追加", () => {
    expect(buildPrompt({ language: "auto" })).toContain("不要翻译");
    const p = buildPrompt({ language: "zh", extraPrompt: "人名：张三" });
    expect(p).toContain("转写语言：zh。");
    expect(p).toContain("补充要求：人名：张三");
  });

  it("缺 DOUBAO_API_KEY → E_CONFIG；base url 去尾斜杠并允许覆盖 model", () => {
    expect(() => getConfig({})).toThrow(expect.objectContaining({ code: "E_CONFIG" }));
    const cfg = getConfig({
      DOUBAO_API_KEY: " k ",
      DOUBAO_BASE_URL: "http://127.0.0.1:9999/api/v3/",
      DOUBAO_TRANSCRIBE_MODEL: "custom-model",
      DOUBAO_TIMEOUT_MS: "1234",
    });
    expect(cfg).toEqual({
      apiKey: "k",
      baseUrl: "http://127.0.0.1:9999/api/v3",
      model: "custom-model",
      timeoutMs: 1234,
    });
    expect(getConfig({ DOUBAO_API_KEY: "k" }).baseUrl).toBe(
      "https://ark.cn-beijing.volces.com/api/v3",
    );
  });
});
