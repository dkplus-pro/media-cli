import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const WHISPER_TIMEOUT_MS = 30 * 60 * 1000;

function tail(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}

// execFile 参数数组调用，禁止 shell 字符串拼接（路径可能含空格）
export async function run(bin, args, { source, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { stdout, stderr };
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
