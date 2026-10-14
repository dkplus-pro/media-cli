import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

export const SWIFT_TARGET = "arm64-apple-macos14.0";

// Swift 工具源码：缓存名含源码 sha256 前 8 位，源码变更自动重编译
// （套路逐行对齐 plugins/media-cutout/lib/config.mjs:54-95）
export function swiftSourcePath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "swift",
    "vision-faces.swift",
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

function missingDependency(message, details) {
  return cliError("E_MISSING_DEPENDENCY", message, {
    dependency: "swiftc",
    hint: "xcode-select --install",
    ...details,
  });
}

async function compile(sourcePath, targetPath, env) {
  const swiftc = findOnPath("swiftc", env);
  if (!swiftc) {
    throw missingDependency(
      "人脸检测需要 macOS 14+ 与 Xcode Command Line Tools（或设置 FACE_BIN 指向已编译的 vision-faces）",
    );
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
    // 编译失败也归为依赖缺失：这台机器上的工具链跑不出可用的检测器
    throw missingDependency("vision-faces 编译失败（可设置 FACE_BIN 指向已编译的二进制）", {
      source: "swiftc",
      stderr: String(err?.stderr ?? err?.message ?? "").slice(-800),
    });
  }
  return targetPath;
}

// 解析人脸检测二进制：FACE_BIN > 源码哈希缓存 > swiftc 现场编译
// env/platform 由 handler 传入（默认值在调用时求值，模块顶层零副作用）
export async function resolveFacesBin(env = process.env, platform = process.platform) {
  const override = env.FACE_BIN;
  if (override) {
    if (!isExecutable(override)) {
      throw cliError("E_MISSING_DEPENDENCY", `FACE_BIN 不可执行：${override}`, {
        dependency: "vision-faces",
        envVar: "FACE_BIN",
        value: override,
      });
    }
    return override;
  }
  if (platform !== "darwin") {
    throw missingDependency(
      `人脸检测引擎 Apple Vision 仅支持 macOS（当前 ${platform}）：可改用 --at x,y,r 人工指定遮脸圆`,
      { platform },
    );
  }
  const sourcePath = swiftSourcePath();
  const sourceHash = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex")
    .slice(0, 8);
  const cachePath = path.join(
    homedir(),
    ".media-cli",
    "cache",
    "media-face-cover",
    `vision-faces-${sourceHash}`,
  );
  if (isExecutable(cachePath)) return cachePath;
  return compile(sourcePath, cachePath, env);
}
