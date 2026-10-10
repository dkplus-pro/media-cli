import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { cliError } from "./errors.mjs";

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

// 音乐分析可吃 ffmpeg 认得的音频与视频（视频取音轨），批量枚举按扩展名过滤
export const MEDIA_EXTS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".aiff",
  ".aif",
  ".wma",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi",
];

// 单文件默认旁路输出：<stem>.music.json（不覆盖原文件）
export function defaultSidecar(input) {
  const stem = input.replace(/\.[^.]+$/, "");
  return `${stem}.music.json`;
}

// 输入枚举：单文件 / 文件夹一级 / --recursive 递归（同型 media-av/files）
export function enumerateInputs(input, { recursive = false } = {}) {
  const info = statSync(input);
  const isSupported = (p) => MEDIA_EXTS.includes(path.extname(p).toLowerCase());
  if (info.isFile()) {
    if (!isSupported(input)) {
      throw cliError("E_INVALID_OPTION", `不支持的文件类型：${input}（仅常见音频/视频）`, {
        option: "--input",
        value: input,
      });
    }
    return [{ path: input, relative: path.basename(input) }];
  }
  if (!info.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输入既不是文件也不是目录：${input}`, {
      option: "--input",
      value: input,
    });
  }

  const files = [];
  const walk = (dir, relativeTo) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !IGNORED_DIRS.has(entry.name)) walk(full, relativeTo);
        continue;
      }
      if (entry.isFile() && isSupported(entry.name)) {
        files.push({ path: full, relative: path.relative(relativeTo, full) });
      }
    }
  };
  walk(input, input);
  return files;
}

// 批量输出的目标路径：<outputDir>/<relative 去扩展名>.music.json（保留相对层级）
export function batchOutputPath(outputDir, relative) {
  const stem = relative.replace(/\.[^.]+$/, "");
  return path.join(outputDir, `${stem}.music.json`);
}
