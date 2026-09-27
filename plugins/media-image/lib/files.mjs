import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { cliError } from "./errors.mjs";
import { SUPPORTED_EXTENSIONS } from "./format.mjs";

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

function isSupportedFile(p) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

// 输入枚举：单文件 / 文件夹一级 / --recursive 递归（对齐 media-cutout D16）
// excludeUnder：跳过该目录（默认输出目录落在输入目录内时，防止二次运行吃到上次产物）
export function enumerateInputs(input, { recursive = false, excludeUnder = null } = {}) {
  const info = statSync(input);
  if (info.isFile()) {
    if (!isSupportedFile(input)) {
      throw cliError(
        "E_INVALID_OPTION",
        `不支持的文件类型：${input}（仅 ${SUPPORTED_EXTENSIONS.join("/")}）`,
        {
          option: "--input",
          value: input,
        },
      );
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
      if (entry.isFile() && isSupportedFile(entry.name)) {
        files.push({ path: full, relative: path.relative(relativeTo, full) });
      }
    }
  };
  walk(input, input);
  return files;
}

// 单文件默认旁路输出：<stem>.<tag>.<ext>（不覆盖原图）
export function defaultSidecar(input, tag) {
  const ext = path.extname(input);
  const stem = input.slice(0, input.length - ext.length);
  return `${stem}.${tag}${ext}`;
}
