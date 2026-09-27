import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { cliError } from "./errors.mjs";

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

// 输入枚举：单文件 / 文件夹一级 / --recursive 递归（同型 media-image/files，扩展名由命令给定）
// excludeUnder：跳过该目录（默认输出目录落在输入目录内时，防止二次运行吃到上次产物）
export function enumerateInputs(input, { exts, recursive = false, excludeUnder = null } = {}) {
  const info = statSync(input);
  const isSupported = (p) => exts.includes(path.extname(p).toLowerCase());
  if (info.isFile()) {
    if (!isSupported(input)) {
      throw cliError("E_INVALID_OPTION", `不支持的文件类型：${input}（仅 ${exts.join(" ")}）`, {
        option: "--input",
        value: input,
      });
    }
    return [input];
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
        if (excludeUnder !== null && path.resolve(full) === excludeUnder) continue;
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

// 单文件默认旁路输出：<stem>.<tag><ext>（不覆盖原文件）
export function defaultSidecar(input, tag, ext) {
  const stem = input.replace(/\.[^.]+$/, "");
  return `${stem}.${tag}${ext}`;
}
