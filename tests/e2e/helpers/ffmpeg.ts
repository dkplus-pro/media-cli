import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export function findBin(names: string[]): string | null {
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

export function runnable(bin: string | null): boolean {
  if (!bin) return false;
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 仅在 hasFfmpeg 守卫内调用（夹具生成用）
export function ffmpegBin(): string {
  const bin = process.env.FFMPEG_PATH ?? findBin(["ffmpeg"]);
  if (!bin) throw new Error("ffmpeg not found");
  return bin;
}

export const hasFfmpeg =
  runnable(process.env.FFMPEG_PATH ?? findBin(["ffmpeg"])) &&
  runnable(process.env.FFPROBE_PATH ?? findBin(["ffprobe"]));
