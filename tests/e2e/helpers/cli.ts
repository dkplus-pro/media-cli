import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BIN = fileURLToPath(new URL("../../../dist/media-cli.js", import.meta.url));

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

// e2e 统一助手：spawn dist 真进程；cwd 供测默认输出目录（注意 macOS 会解析为 realpath）
export async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<CliRun> {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: merged,
      ...(cwd ? { cwd } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

export interface CliEnveloped {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: unknown[];
}
