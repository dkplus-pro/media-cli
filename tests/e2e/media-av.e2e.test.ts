import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

// env 值为 undefined 表示从继承环境中删除该变量（避免本机 FFMPEG_PATH 等污染错误分支断言）
async function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: merged,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

function findBin(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // 下一个
      }
    }
  }
  return null;
}

function runnable(bin: string | null): boolean {
  if (!bin) return false;
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg =
  runnable(process.env.FFMPEG_PATH ?? findBin(["ffmpeg"])) &&
  runnable(process.env.FFPROBE_PATH ?? findBin(["ffprobe"]));
const hasWhisper =
  Boolean(process.env.WHISPER_MODEL) &&
  Boolean(process.env.WHISPER_CPP_BIN ?? findBin(["whisper-cli", "whisper-cpp"]));

describe("media-av 错误分支（无需本地二进制）", () => {
  it("media-filmstrip 缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-filmstrip"], { FFMPEG_PATH: undefined });
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("E_MISSING_ARGUMENT");
  });

  it("--format 非法值 → E_INVALID_OPTION 退出 2", async () => {
    const r = await cli(["--json", "media-filmstrip", "--input", "x.mp4", "--format", "xyz"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("E_INVALID_OPTION");
  });

  it("FFMPEG_PATH 指向不可执行路径 → E_MISSING_DEPENDENCY 退出 3，details 带安装提示", async () => {
    const r = await cli(["--json", "media-to-audio", "--input", "x.mp4"], {
      FFMPEG_PATH: "/nonexistent",
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as {
      error: { code: string; details: { hint: string; dependency: string } };
    };
    expect(parsed.error.code).toBe("E_MISSING_DEPENDENCY");
    expect(parsed.error.details.dependency).toBe("ffmpeg");
    expect(typeof parsed.error.details.hint).toBe("string");
  });

  it("media-transcribe 缺 WHISPER_MODEL → E_CONFIG 退出 3", async () => {
    const r = await cli(["--json", "media-transcribe", "--input", "x.mp3"], {
      WHISPER_MODEL: undefined,
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("E_CONFIG");
  });

  it("WHISPER_MODEL 指向不存在文件 → E_CONFIG", async () => {
    const r = await cli(["--json", "media-transcribe", "--input", "x.mp3"], {
      WHISPER_MODEL: "/nonexistent.bin",
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("E_CONFIG");
  });

  it("WHISPER_CPP_BIN 不可执行 → E_MISSING_DEPENDENCY（模型存在仅作占位）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "media-av-e2e-"));
    try {
      const fakeModel = path.join(dir, "fake.bin");
      await writeFile(fakeModel, "");
      const r = await cli(["--json", "media-transcribe", "--input", "x.mp3"], {
        WHISPER_MODEL: fakeModel,
        WHISPER_CPP_BIN: "/nonexistent",
      });
      expect(r.code).toBe(3);
      const parsed = JSON.parse(r.stdout) as { error: { code: string } };
      expect(parsed.error.code).toBe("E_MISSING_DEPENDENCY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("spec 自省含三个 media-* 命令且 source 为 plugin:media-av", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const byName = new Map(parsed.data.commands.map((c) => [c.name, c]));
    for (const name of ["media-filmstrip", "media-to-audio", "media-transcribe"]) {
      expect(byName.get(name)?.source).toBe("plugin:media-av");
    }
  });
});

describe.skipIf(!hasFfmpeg)("media-av ffmpeg 集成", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-av-fix-"));
    const ffmpeg =
      process.env.FFMPEG_PATH ??
      (() => {
        const p = findBin(["ffmpeg"]);
        if (!p) throw new Error("ffmpeg not found");
        return p;
      })();
    const run = (args: string[]) =>
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    run([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=6:size=640x360:rate=60",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path.join(dir, "sample.mp4"),
    ]);
    run(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", path.join(dir, "tone.wav")]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("filmstrip 默认参数：16 格、时长正确、整图宽 1280", async () => {
    const out = path.join(dir, "grid.jpg");
    const r = await cli([
      "--json",
      "media-filmstrip",
      "--input",
      path.join(dir, "sample.mp4"),
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      data: {
        path: string;
        width: number;
        height: number;
        cells: number;
        durationSec: number;
        timestamps: boolean;
      };
      warnings: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.cells).toBe(16);
    expect(Math.abs(parsed.data.durationSec - 6)).toBeLessThan(0.1);
    expect(parsed.data.width).toBe(1280);
    expect(parsed.data.height).toBeGreaterThan(0);
    expect(typeof parsed.data.timestamps).toBe("boolean");
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(10_000);
  }, 30_000);

  it("filmstrip --cell-width 160 --format png", async () => {
    const out = path.join(dir, "grid.png");
    const r = await cli([
      "--json",
      "media-filmstrip",
      "--input",
      path.join(dir, "sample.mp4"),
      "--output",
      out,
      "--cell-width",
      "160",
      "--format",
      "png",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { data: { width: number } };
    expect(parsed.data.width).toBe(640);
    await expect(stat(out)).resolves.toBeTruthy();
  }, 30_000);

  it("filmstrip 输入 audio-only → E_PROVIDER_ERROR 退出 3", async () => {
    const r = await cli(["--json", "media-filmstrip", "--input", path.join(dir, "tone.wav")]);
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("E_PROVIDER_ERROR");
  }, 30_000);

  it("to-audio mp3 与 wav 输出非空", async () => {
    for (const format of ["mp3", "wav"]) {
      const out = path.join(dir, `out.${format}`);
      const r = await cli([
        "--json",
        "media-to-audio",
        "--input",
        path.join(dir, "sample.mp4"),
        "--format",
        format,
        "--output",
        out,
      ]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { path: string; format: string; bytes: number; durationSec: number };
      };
      expect(parsed.data.format).toBe(format);
      expect(parsed.data.bytes).toBeGreaterThan(0);
      expect(Math.abs(parsed.data.durationSec - 6)).toBeLessThan(0.5);
      await expect(stat(out)).resolves.toBeTruthy();
    }
  }, 60_000);

  it("to-audio 缺省 --output → <input>.mp3 落盘", async () => {
    const input = path.join(dir, "sample.mp4");
    const r = await cli(["--json", "media-to-audio", "--input", input]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { data: { path: string } };
    expect(parsed.data.path).toBe(`${input}.mp3`);
    await expect(stat(`${input}.mp3`)).resolves.toBeTruthy();
  }, 30_000);
});

// whisper 转写链路内部也要用 ffmpeg（转 16k wav），所以两依赖齐备才跑
describe.skipIf(!hasWhisper || !hasFfmpeg)("media-transcribe 集成", () => {
  it("音频转 SRT：产出合法字幕文件", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "media-av-whisper-"));
    try {
      const ffmpeg = process.env.FFMPEG_PATH ?? findBin(["ffmpeg"]);
      execFileSync(ffmpeg as string, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        path.join(dir, "tone.wav"),
      ]);
      const out = path.join(dir, "out.srt");
      const r = await cli([
        "--json",
        "media-transcribe",
        "--input",
        path.join(dir, "tone.wav"),
        "--output",
        out,
      ]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { path: string; segments: number; language: string };
      };
      expect(parsed.data.path).toBe(out);
      expect(typeof parsed.data.segments).toBe("number");
      await expect(stat(out)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
