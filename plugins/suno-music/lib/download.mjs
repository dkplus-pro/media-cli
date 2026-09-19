import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./config.mjs";

export async function downloadFile(url, destPath) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `下载失败：${String(err?.message ?? err)}`, {
      reason: "download_failed",
    });
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `下载失败（HTTP ${res.status}）`, {
      reason: "download_failed",
      status: res.status,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    await writeFile(destPath, buf);
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `写盘失败：${String(err?.message ?? err)}`, {
      reason: "write_failed",
      path: destPath,
    });
  }
  return { path: destPath, bytes: buf.length };
}

// count>=2 时按 <base>-<序号>.mp3 命名（序号为 completed 任务按提交顺序的稠密编号）
export function resolveOutputPath(output, index, count, taskId, cwd) {
  if (output === undefined) {
    return path.resolve(cwd, `suno-${taskId}.mp3`);
  }
  const target = path.resolve(cwd, output);
  if (count >= 2) {
    const ext = path.extname(target);
    return `${target.slice(0, target.length - ext.length)}-${index + 1}${ext || ".mp3"}`;
  }
  return target;
}
