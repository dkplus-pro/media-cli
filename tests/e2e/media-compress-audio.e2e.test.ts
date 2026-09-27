import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnveloped, cli } from "./helpers/cli";
import { ffmpegBin, hasFfmpeg } from "./helpers/ffmpeg";

describe("media-compress-audio 错误分支（无需本地二进制）", () => {
  it("缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-compress-audio"], { FFMPEG_PATH: undefined });
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("--bitrate 非法 → E_INVALID_OPTION", async () => {
    const r = await cli([
      "--json",
      "media-compress-audio",
      "--input",
      "x.mp3",
      "--bitrate",
      "loud",
    ]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_INVALID_OPTION");
  });

  it("--format 非法 → E_INVALID_OPTION", async () => {
    const r = await cli(["--json", "media-compress-audio", "--input", "x.mp3", "--format", "wma"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_INVALID_OPTION");
  });

  it("FFMPEG_PATH 指向不可执行路径 → E_MISSING_DEPENDENCY 退出 3", async () => {
    const r = await cli(["--json", "media-compress-audio", "--input", "x.mp3"], {
      FFMPEG_PATH: "/nonexistent",
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_DEPENDENCY");
  });
});

describe.skipIf(!hasFfmpeg)("media-compress-audio ffmpeg 集成", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-ca-e2e-"));
    const ffmpeg = ffmpegBin();
    const run = (args: string[]) =>
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    // wav（pcm 无损，体积大）
    run(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", path.join(dir, "tone.wav")]);
    // 高码率 mp3（320k，重压收益明显）
    run([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "320k",
      path.join(dir, "big.mp3"),
    ]);
    // 低码率小 mp3（8k，重压只会更大 → skipped 分支）
    run([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "8k",
      path.join(dir, "tiny.mp3"),
    ]);
    // 视频文件（扩展名过滤拒绝分支）
    run([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=1:size=160x120:rate=15",
      path.join(dir, "clip.mp4"),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("wav 默认转 flac：无损缩小、bitrate 报 lossless", async () => {
    const r = await cli(["--json", "media-compress-audio", "--input", path.join(dir, "tone.wav")]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        path: string;
        format: string;
        bitrate: string;
        durationSec: number;
        bytesBefore: number;
        bytesAfter: number;
        skipped: boolean;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.path).toBe(path.join(dir, "tone.min.flac"));
    expect(parsed.data.format).toBe("flac");
    expect(parsed.data.bitrate).toBe("lossless");
    expect(Math.abs(parsed.data.durationSec - 2)).toBeLessThan(0.5);
    expect(parsed.data.skipped).toBe(false);
    expect(parsed.data.bytesAfter).toBeLessThan(parsed.data.bytesBefore);
  }, 60_000);

  it("--format mp3 --bitrate 64k：显式指定格式与码率", async () => {
    const r = await cli([
      "--json",
      "media-compress-audio",
      "--input",
      path.join(dir, "tone.wav"),
      "--format",
      "mp3",
      "--bitrate",
      "64k",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { path: string; format: string; bitrate: string };
    };
    expect(parsed.data.path).toBe(path.join(dir, "tone.min.mp3"));
    expect(parsed.data.format).toBe("mp3");
    expect(parsed.data.bitrate).toBe("64k");
  }, 60_000);

  it("mp3 320k 默认重压 128k：保持 mp3、体积变小", async () => {
    const r = await cli(["--json", "media-compress-audio", "--input", path.join(dir, "big.mp3")]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        path: string;
        format: string;
        bitrate: string;
        bytesBefore: number;
        bytesAfter: number;
      };
    };
    expect(parsed.data.path).toBe(path.join(dir, "big.min.mp3"));
    expect(parsed.data.format).toBe("mp3");
    expect(parsed.data.bitrate).toBe("128k");
    expect(parsed.data.bytesAfter).toBeLessThan(parsed.data.bytesBefore);
  }, 60_000);

  it("已足够小的 mp3：跳过落盘", async () => {
    const out = path.join(dir, "tiny-out.mp3");
    const r = await cli([
      "--json",
      "media-compress-audio",
      "--input",
      path.join(dir, "tiny.mp3"),
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { skipped: boolean; bytesBefore: number; bytesAfter: number };
    };
    expect(parsed.data.skipped).toBe(true);
    expect(parsed.data.bytesAfter).toBe(parsed.data.bytesBefore);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("视频文件输入 → E_INVALID_OPTION（扩展名过滤）", async () => {
    const r = await cli(["--json", "media-compress-audio", "--input", path.join(dir, "clip.mp4")]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_INVALID_OPTION");
  }, 60_000);

  it("文件夹批量：默认输出 ./min（cwd 相对）、坏文件进 failed、汇总字节", async () => {
    const workDir = path.join(dir, "cwd-batch");
    const ffmpeg = ffmpegBin();
    const run = (args: string[]) =>
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    await mkdir(path.join(workDir, "batch"), { recursive: true });
    run([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      path.join(workDir, "batch", "a.wav"),
    ]);
    await writeFile(path.join(workDir, "batch", "broken.wav"), "not audio");
    const r = await cli(["--json", "media-compress-audio", "--input", "batch"], {}, workDir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        outputDir: string;
        results: { path: string; bytesBefore: number; bytesAfter: number; skipped: boolean }[];
        failed: { file: string; reason: string }[];
        total: number;
        bytesBefore: number;
        bytesAfter: number;
      };
    };
    // 子进程 cwd 会被系统解析为 realpath（macOS /tmp 符号链接），两侧都用 realpath 比较
    expect(parsed.data.outputDir).toBe(realpathSync(path.join(workDir, "min")));
    expect(parsed.data.total).toBe(2); // a.wav + broken.wav
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0].path).toBe(realpathSync(path.join(workDir, "min", "a.flac")));
    expect(parsed.data.failed).toHaveLength(1);
    expect(parsed.data.failed[0].file).toContain("broken.wav");
    expect(parsed.data.bytesAfter).toBeLessThan(parsed.data.bytesBefore);
  }, 60_000);
});
