import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { cliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

function findOnPath(name, env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // 继续找下一个目录
    }
  }
  return null;
}

function resolveBinary({ envVar, names, dependency, hint }, env = process.env) {
  const override = env[envVar];
  if (override) {
    try {
      accessSync(override, constants.X_OK);
      return override;
    } catch {
      throw cliError("E_MISSING_DEPENDENCY", `${dependency} 不可执行：${override}`, {
        dependency,
        envVar,
        value: override,
        hint,
      });
    }
  }
  for (const name of names) {
    const found = findOnPath(name, env);
    if (found) return found;
  }
  throw cliError("E_MISSING_DEPENDENCY", `找不到 ${dependency}（${names.join(" / ")}）`, {
    dependency,
    hint,
  });
}

export function resolveFfmpeg(env = process.env) {
  return resolveBinary(
    {
      envVar: "FFMPEG_PATH",
      names: ["ffmpeg"],
      dependency: "ffmpeg",
      hint: "brew install ffmpeg 或设置 FFMPEG_PATH",
    },
    env,
  );
}

export function resolveFfprobe(env = process.env) {
  return resolveBinary(
    {
      envVar: "FFPROBE_PATH",
      names: ["ffprobe"],
      dependency: "ffprobe",
      hint: "brew install ffmpeg 或设置 FFPROBE_PATH",
    },
    env,
  );
}

function tail(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}

// execFile 参数数组调用，禁止 shell 字符串拼接（路径可能含空格）
export async function run(bin, args, { source, timeoutMs = FFMPEG_TIMEOUT_MS }) {
  try {
    return await execFileAsync(bin, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const stderr = tail(err.stderr, 10);
    const message = err.killed
      ? `${source} 执行超时（${timeoutMs}ms）`
      : `${source} 执行失败${stderr ? `：${stderr}` : `：${err.message}`}`;
    throw cliError("E_PROVIDER_ERROR", message, {
      source,
      exitCode: err.code ?? null,
      signal: err.signal ?? null,
      ...(err.killed ? { reason: "timeout" } : {}),
      stderr,
    });
  }
}
