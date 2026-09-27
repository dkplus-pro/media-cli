import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnveloped, cli } from "./helpers/cli";
import { ffmpegBin, hasFfmpeg } from "./helpers/ffmpeg";

describe("media-compress-video 错误分支（无需本地二进制）", () => {
  it("缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-compress-video"], { FFMPEG_PATH: undefined });
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_ARGUMENT");
  });

  for (const [option, value] of [
    ["--crf", "abc"],
    ["--preset", "xyz"],
    ["--codec", "vp9"],
    ["--format", "avi"],
    ["--max-height", "0"],
  ] as const) {
    it(`${option} 非法值 → E_INVALID_OPTION 退出 2`, async () => {
      const r = await cli(["--json", "media-compress-video", "--input", "x.mp4", option, value]);
      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout) as CliEnveloped;
      expect(parsed.error?.code).toBe("E_INVALID_OPTION");
    });
  }

  it("FFMPEG_PATH 指向不可执行路径 → E_MISSING_DEPENDENCY 退出 3", async () => {
    const r = await cli(["--json", "media-compress-video", "--input", "x.mp4"], {
      FFMPEG_PATH: "/nonexistent",
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_DEPENDENCY");
    expect(parsed.error?.details).toMatchObject({ dependency: "ffmpeg" });
  });

  it("spec 自省含 media-compress-video / media-compress-audio 且 source 为 plugin:media-av", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const byName = new Map(parsed.data.commands.map((c) => [c.name, c]));
    expect(byName.get("media-compress-video")?.source).toBe("plugin:media-av");
    expect(byName.get("media-compress-audio")?.source).toBe("plugin:media-av");
  });
});

describe.skipIf(!hasFfmpeg)("media-compress-video ffmpeg 集成", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-cv-e2e-"));
    const ffmpeg = ffmpegBin();
    const run = (args: string[]) =>
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    // 默认编码器（mpeg4）冗余大，重编码 H.264 CRF 26 收益明显
    run([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=4:size=320x240:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:a",
      "aac",
      path.join(dir, "sample.mp4"),
    ]);
    // 无视频轨的 mp4（纯音频）→ hasVideo 拒绝分支
    run([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "aac",
      path.join(dir, "audio-only.mp4"),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("单文件默认参数：体积变小、分辨率不变、默认旁路输出", async () => {
    const r = await cli([
      "--json",
      "media-compress-video",
      "--input",
      path.join(dir, "sample.mp4"),
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        path: string;
        format: string;
        codec: string;
        width: number;
        height: number;
        durationSec: number;
        bytesBefore: number;
        bytesAfter: number;
        savedBytes: number;
        skipped: boolean;
        crf: number;
        preset: string;
        maxHeight: null;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.path).toBe(path.join(dir, "sample.min.mp4"));
    expect(parsed.data.format).toBe("mp4");
    expect(parsed.data.codec).toBe("h264");
    expect(parsed.data.width).toBe(320);
    expect(parsed.data.height).toBe(240);
    expect(Math.abs(parsed.data.durationSec - 4)).toBeLessThan(0.5);
    expect(parsed.data.skipped).toBe(false);
    expect(parsed.data.bytesAfter).toBeLessThan(parsed.data.bytesBefore);
    expect(parsed.data.savedBytes).toBe(parsed.data.bytesBefore - parsed.data.bytesAfter);
    expect(parsed.data.crf).toBe(26);
    expect(parsed.data.preset).toBe("medium");
    expect(parsed.data.maxHeight).toBe(null);
    expect(existsSync(parsed.data.path)).toBe(true);
  }, 120_000);

  it("--max-height 120：降分辨率到高度上限", async () => {
    const r = await cli([
      "--json",
      "media-compress-video",
      "--input",
      path.join(dir, "sample.mp4"),
      "--max-height",
      "120",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { width: number; height: number };
    };
    expect(parsed.data.height).toBe(120);
    expect(parsed.data.width).toBe(160);
  }, 120_000);

  it("纯音频 mp4 → E_INVALID_OPTION（音频压缩用 media-compress-audio）", async () => {
    const r = await cli([
      "--json",
      "media-compress-video",
      "--input",
      path.join(dir, "audio-only.mp4"),
    ]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_INVALID_OPTION");
  }, 60_000);

  it("--output 与输入相同 → E_INVALID_OPTION（拒绝原地覆盖）", async () => {
    const input = path.join(dir, "sample.mp4");
    const r = await cli(["--json", "media-compress-video", "--input", input, "--output", input]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_INVALID_OPTION");
  }, 60_000);
});
