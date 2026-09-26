import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

// Swift 工具源码（缓存名含源码哈希，源码变更自动重编译）
export function swiftSourcePath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "swift",
    "vision-cutout.swift",
  );
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export const SWIFT_TARGET = "arm64-apple-macos14.0";

async function compile(sourcePath, targetPath, env) {
  const swiftc = findOnPath("swiftc", env);
  if (!swiftc) {
    throw cliError("E_MISSING_DEPENDENCY", "抠图需要 macOS 14+ 与 Xcode Command Line Tools", {
      dependency: "swiftc",
      hint: "xcode-select --install（或设置 CUTOUT_BIN 指向已编译的 vision-cutout）",
    });
  }
  const tmpTarget = `${targetPath}.${process.pid}.tmp`;
  try {
    // swiftc 不会创建输出目录，必须先建缓存目录
    mkdirSync(path.dirname(targetPath), { recursive: true });
    await execFileAsync(swiftc, ["-O", "-target", SWIFT_TARGET, sourcePath, "-o", tmpTarget], {
      encoding: "utf8",
      timeout: 120_000,
    });
    renameSync(tmpTarget, targetPath); // rename 保证并发编译下的原子可见性
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", "vision-cutout 编译失败", {
      source: "swiftc",
      stderr: String(err?.stderr ?? err?.message ?? "").slice(-800),
    });
  }
  return targetPath;
}

// 解析抠图二进制：CUTOUT_BIN > 源码哈希缓存 > swiftc 现场编译
export async function resolveCutoutBin(env = process.env) {
  const override = env.CUTOUT_BIN;
  if (override) {
    if (!isExecutable(override)) {
      throw cliError("E_MISSING_DEPENDENCY", `CUTOUT_BIN 不可执行：${override}`, {
        dependency: "vision-cutout",
        envVar: "CUTOUT_BIN",
        value: override,
      });
    }
    return override;
  }
  const sourcePath = swiftSourcePath();
  const sourceHash = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex")
    .slice(0, 8);
  const cachePath = path.join(
    homedir(),
    ".common-cli",
    "cache",
    "media-cutout",
    `vision-cutout-${sourceHash}`,
  );
  if (isExecutable(cachePath)) return cachePath;
  return compile(sourcePath, cachePath, env);
}

// 仅用于测试与调用方判断输出尺寸（stat 便捷封装）
export function fileSize(p) {
  return statSync(p).size;
}
