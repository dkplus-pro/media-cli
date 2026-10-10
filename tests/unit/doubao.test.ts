import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnalysisOptions } from "../../plugins/doubao/lib/analysis.mjs";
import { batchOutputPath, defaultSidecar } from "../../plugins/doubao/lib/analysis-files.mjs";
import { extractJsonObject, structureCovers } from "../../plugins/doubao/lib/analysis-prompt.mjs";
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
    // 模型 id 不内置默认值（豆包型号按月更新，写死会失效）
    expect(getConfig({ DOUBAO_API_KEY: "k" }).model).toBeNull();
  });
});

describe("doubao 音乐分析：JSON 提取与时间轴兜底", () => {
  const analysis = JSON.stringify({ isMusic: true, genre: ["Cinematic"] });

  it("extractJsonObject 兼容裸 JSON / ```json 围栏 / 前后闲话", () => {
    expect(extractJsonObject(analysis)).toEqual({ isMusic: true, genre: ["Cinematic"] });
    expect(extractJsonObject(`\`\`\`json\n${analysis}\n\`\`\``)).toEqual({
      isMusic: true,
      genre: ["Cinematic"],
    });
    expect(extractJsonObject(`好的，以下是分析：\n${analysis}\n希望有帮助`)).toEqual({
      isMusic: true,
      genre: ["Cinematic"],
    });
  });

  it("extractJsonObject：字符串里的花括号不干扰配平，非法/非对象/残缺 → E_PROVIDER_ERROR bad_json", () => {
    expect(extractJsonObject('{"a":"包含 } 花括号","b":{"c":1}}')).toEqual({
      a: "包含 } 花括号",
      b: { c: 1 },
    });
    const bad = (text: string) =>
      expect(() => extractJsonObject(text)).toThrow(
        expect.objectContaining({ code: "E_PROVIDER_ERROR" }),
      );
    bad("完全没有 JSON");
    bad("[1,2,3]"); // 数组不是对象
    bad('{"a":1'); // 残缺
    bad("{invalid}");
  });

  it("structureCovers：末段接近结尾为真，显著缺口为假（时间戳漂移兜底）", () => {
    expect(structureCovers([{ startSec: 0, endSec: 100 }], 100)).toBe(true);
    expect(structureCovers([{ startSec: 0, endSec: 80 }], 100)).toBe(true);
    expect(structureCovers([{ startSec: 0, endSec: 60 }], 100)).toBe(false);
    expect(structureCovers([], 100)).toBe(false); // 无分段视为未覆盖
    expect(structureCovers(undefined, 100)).toBe(false);
  });

  it("分析选项默认值与越界夹取：segment-seconds 60–300，concurrency 1–8", () => {
    expect(parseAnalysisOptions({})).toMatchObject({ segmentSeconds: 120, concurrency: 4 });
    expect(parseAnalysisOptions({ segmentSeconds: "30" }).segmentSeconds).toBe(60);
    expect(parseAnalysisOptions({ segmentSeconds: "999" }).segmentSeconds).toBe(300);
    expect(parseAnalysisOptions({ concurrency: "99" }).concurrency).toBe(8);
    expect(parseAnalysisOptions({ model: "m1" }).model).toBe("m1");
    expect(() => parseAnalysisOptions({ concurrency: "abc" })).toThrow(
      expect.objectContaining({ code: "E_INVALID_OPTION" }),
    );
  });

  it("输出路径：单文件旁路 <stem>.music.json，批量保留相对层级", () => {
    expect(defaultSidecar("/a/b/曲子.mp3")).toBe("/a/b/曲子.music.json");
    expect(batchOutputPath("/out", "子目录/曲子.flac")).toBe(
      path.join("/out", "子目录", "曲子.music.json"),
    );
  });
});
