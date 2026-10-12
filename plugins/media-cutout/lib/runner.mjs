import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { promisify } from "node:util";
import { cliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

// 调用 Swift 工具处理单张图片；stderr "E:*" 映射为 E_PROVIDER_ERROR
export async function cutoutOne(bin, { input, output, padding }) {
  try {
    await execFileAsync(bin, [input, output, String(padding)], {
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    const reason = /^E:(.+)$/m.exec(stderr)?.[1]?.trim() ?? String(err?.message ?? err);
    const noSubject = reason.includes("no foreground subject");
    throw cliError("E_PROVIDER_ERROR", `抠图失败：${reason}`, {
      source: "vision",
      file: input,
      ...(noSubject ? { reason: "no_subject" } : {}),
      stderr: stderr.slice(-400),
    });
  }
}

// 读 PNG IHDR 宽高（固定偏移 16/20，零依赖、不依赖 ffprobe）
export function readPngSize(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(24);
    readSync(fd, header, 0, 24, 0);
    if (header.toString("ascii", 1, 4) !== "PNG") {
      throw cliError("E_PROVIDER_ERROR", `输出不是合法 PNG：${filePath}`, { file: filePath });
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}
