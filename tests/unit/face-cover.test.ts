import { describe, expect, it } from "vitest";
import { parseFacesOutput, reasonFromStderr } from "../../plugins/media-image/lib/detect-faces.mjs";
import {
  buildCircleSvg,
  circleForFace,
  clampCircle,
  facesToCircles,
  parseAtList,
  parseMinConfidence,
  parseScale,
} from "../../plugins/media-image/lib/face-cover.mjs";
import { resolveFacesBin } from "../../plugins/media-image/lib/faces-bin.mjs";

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

// 与 agnes.test.ts 同风格：把鸭子类型错误取回来逐字段断言，而不是只看错误码
function capture(fn: () => unknown): CliErr {
  try {
    fn();
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

async function captureAsync(promise: Promise<unknown>): Promise<CliErr> {
  try {
    await promise;
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

const FACE = { x: 100, y: 100, w: 200, h: 100, confidence: 0.9, quality: null };

describe("media-face-cover 圆几何", () => {
  it("内切圆 = min(w,h)/2 × scale，圆心 = 框中心", () => {
    expect(circleForFace(FACE, 1.2)).toMatchObject({ cx: 200, cy: 150, r: 60, source: "vision" });
    expect(circleForFace(FACE, 1)).toMatchObject({ r: 50 });
    expect(circleForFace(FACE, 3)).toMatchObject({ r: 150 });
    // 竖长框取宽度
    expect(circleForFace({ ...FACE, w: 80, h: 300 }, 1)).toMatchObject({ cx: 140, cy: 250, r: 40 });
  });

  it("--scale 与 --min-confidence 边界（0.5–3.0 / 0–1）", () => {
    expect(parseScale(undefined)).toBe(1.2);
    expect(parseScale("0.5")).toBe(0.5);
    expect(parseScale("3")).toBe(3);
    expect(parseMinConfidence(undefined)).toBe(0.3);
    expect(parseMinConfidence("0")).toBe(0);
    expect(parseMinConfidence("1")).toBe(1);
    for (const raw of ["0.49", "3.01", "abc", "-1"]) {
      expect(capture(() => parseScale(raw)).code).toBe("E_INVALID_OPTION");
    }
    for (const raw of ["1.01", "-0.01", "nope"]) {
      expect(capture(() => parseMinConfidence(raw)).code).toBe("E_INVALID_OPTION");
    }
  });

  it("min-confidence 过滤 + 退化框（w/h<=0）丢弃", () => {
    const faces = [
      FACE,
      { ...FACE, x: 500, confidence: 0.29 },
      { ...FACE, x: 700, w: 0, h: 40, confidence: 0.99 },
    ];
    const kept = facesToCircles(faces, { scale: 1.2, minConfidence: 0.3 });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ cx: 200, confidence: 0.9 });
    expect(facesToCircles(faces, { scale: 1.2, minConfidence: 0 })).toHaveLength(2);
  });

  it("圆心 clamp 进画布（圆本身超出交给 SVG 裁）", () => {
    const canvas = { width: 1000, height: 800 };
    expect(clampCircle({ cx: -50, cy: -50, r: 10 }, canvas.width, canvas.height)).toMatchObject({
      cx: 0,
      cy: 0,
      r: 10,
    });
    expect(clampCircle({ cx: 5000, cy: 900, r: 10 }, canvas.width, canvas.height)).toMatchObject({
      cx: 1000,
      cy: 800,
      r: 10,
    });
    expect(clampCircle({ cx: 200, cy: 150, r: 60 }, canvas.width, canvas.height)).toMatchObject({
      cx: 200,
      cy: 150,
    });
  });

  it("--at 解析：字符串/数组都吃，产出 source=manual", () => {
    expect(parseAtList(undefined)).toEqual([]);
    expect(parseAtList("10,20,30")).toEqual([
      { x: 10, y: 20, r: 30, confidence: null, source: "manual" },
    ]);
    // commander 变参 --at 每次出现累加成数组
    expect(parseAtList(["1,2,3", " 4 , 5 , 6 "])).toEqual([
      { x: 1, y: 2, r: 3, confidence: null, source: "manual" },
      { x: 4, y: 5, r: 6, confidence: null, source: "manual" },
    ]);
  });

  it("--at 非法形态 → E_INVALID_OPTION 且 details.option 为 --at", () => {
    for (const raw of ["1,2", "1,2,3,4", "a,b,c", "1,2,x", "1,2,-3", "1,2,0", "", "1,,3"]) {
      const err = capture(() => parseAtList(raw));
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--at" });
    }
  });

  it("buildCircleSvg：一张全画布 SVG 装下所有圆，颜色原样进 fill", () => {
    const svg = buildCircleSvg({
      width: 1024,
      height: 768,
      circles: [
        { cx: 200, cy: 150.5, r: 60.25 },
        { cx: 0, cy: 0, r: 10 },
      ],
      color: "#FFFFFF",
    });
    expect(
      svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"'),
    ).toBe(true);
    expect(svg).toContain('viewBox="0 0 1024 768"');
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg).toContain('<circle cx="200" cy="150.5" r="60.25" fill="#FFFFFF"/>');
  });
});

describe("vision-faces stdout 解析", () => {
  it("契约样例：像素 + 左上原点，quality 可为 null", () => {
    const parsed = parseFacesOutput(
      '{"width":1024,"height":768,"faces":[{"x":120.5,"y":88,"w":210,"h":210,"confidence":0.99,"quality":null}]}\n',
    );
    expect(parsed).toEqual({
      width: 1024,
      height: 768,
      faces: [{ x: 120.5, y: 88, w: 210, h: 210, confidence: 0.99, quality: null }],
    });
  });

  it("0 张脸是正常输出而不是失败", () => {
    expect(parseFacesOutput('{"width":100,"height":100,"faces":[]}')).toEqual({
      width: 100,
      height: 100,
      faces: [],
    });
  });

  it("取最后一行 JSON（容忍前置噪声行），confidence 缺失按 1", () => {
    const parsed = parseFacesOutput(
      'I/O noise\n{"width":8,"height":8,"faces":[{"x":0,"y":0,"w":2,"h":2}]}',
    );
    expect(parsed.faces[0]).toMatchObject({ confidence: 1, quality: null });
  });

  it("非法输出 → E_PROVIDER_ERROR details.reason=malformed", () => {
    const cases = [
      "",
      "not json at all",
      "[]",
      '{"width":0,"height":10,"faces":[]}',
      '{"width":10,"height":10}',
      '{"width":10,"height":10,"faces":[{"x":"bad","y":1,"w":2,"h":2}]}',
    ];
    for (const stdout of cases) {
      const err = capture(() => parseFacesOutput(stdout, "a.png"));
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details).toMatchObject({ source: "vision", reason: "malformed", file: "a.png" });
    }
  });

  it("stderr 的 E: 行是失败原因，缺行回退原始错误文本", () => {
    expect(reasonFromStderr("E:cannot read image: /tmp/x.png\n", "fallback")).toBe(
      "cannot read image: /tmp/x.png",
    );
    expect(reasonFromStderr("warning: noisy\nE:vision request failed: boom", "fallback")).toBe(
      "vision request failed: boom",
    );
    expect(reasonFromStderr("nothing useful", "Command failed")).toBe("Command failed");
  });
});

describe("resolveFacesBin 依赖解析", () => {
  it("FACE_BIN 优先，且非 darwin 也放行（人工指定已编译产物）", async () => {
    expect(await resolveFacesBin({ FACE_BIN: process.execPath }, "linux")).toBe(process.execPath);
  });

  it("FACE_BIN 不可执行 → E_MISSING_DEPENDENCY details.dependency=vision-faces", async () => {
    const err = await captureAsync(resolveFacesBin({ FACE_BIN: "/nonexistent-bin" }, "darwin"));
    expect(err.code).toBe("E_MISSING_DEPENDENCY");
    expect(err.details).toMatchObject({ dependency: "vision-faces", envVar: "FACE_BIN" });
  });

  it("非 macOS → E_MISSING_DEPENDENCY 带 xcode-select 提示", async () => {
    const err = await captureAsync(resolveFacesBin({}, "win32"));
    expect(err.code).toBe("E_MISSING_DEPENDENCY");
    expect(err.details).toMatchObject({
      dependency: "swiftc",
      hint: "xcode-select --install",
      platform: "win32",
    });
  });

  it("PATH 里没有 swiftc → E_MISSING_DEPENDENCY，message 指路 FACE_BIN", async () => {
    // homedir() 读的是真实 process.env.HOME：指到空目录才能绕开 ~/.media-cli/cache
    // 里可能已存在的编译产物，强制走「缓存未命中 + swiftc 缺失」分支
    const savedHome = process.env.HOME;
    process.env.HOME = "/tmp/media-cli-no-home";
    try {
      const err = await captureAsync(resolveFacesBin({ PATH: "/nonexistent-dir" }, "darwin"));
      expect(err.code).toBe("E_MISSING_DEPENDENCY");
      expect(err.details).toMatchObject({ dependency: "swiftc", hint: "xcode-select --install" });
      expect(err.message).toContain("FACE_BIN");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
