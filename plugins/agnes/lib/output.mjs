import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./errors.mjs";

let sharpPromise;

// 懒加载 sharp：不在模块顶层 import（插件被加载即执行顶层代码），
// 原生依赖缺失时给 E_MISSING_DEPENDENCY 而不是让插件加载失败
export async function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((m) => m.default ?? m)
      .catch((err) => {
        sharpPromise = undefined;
        throw cliError("E_MISSING_DEPENDENCY", `sharp 图片引擎加载失败：${err?.message ?? err}`, {
          dependency: "sharp",
          hint: "重新安装：npm i -g @dkplus/media-cli（或在本仓库 pnpm install）",
        });
      });
  }
  return sharpPromise;
}

// D21：契约是「真实像素」——显式 WxH 会被 provider 降采样（实测 2048x1152 → 1312x736），
// 所以 data.size 必须由 sharp 解出实际尺寸，解不出来（非图像/损坏）就退回请求值。
// sharp 实例由调用方在发请求前 loadSharp() 拿到：缺原生依赖要早于花额度失败
export async function actualPixels(sharp, buffer) {
  const meta = await sharp(buffer)
    .metadata()
    .catch(() => ({}));
  if (typeof meta.width !== "number" || typeof meta.height !== "number") return undefined;
  return `${meta.width}x${meta.height}`;
}

export function defaultOutputName(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// 输出目录不存在属于用法错误：必须在发任何网络请求之前拦下
export async function resolveOutputPath({ output, cwd, prefix, ext }) {
  const target = path.resolve(cwd, output ?? `${defaultOutputName(prefix)}.${ext}`);
  const parent = await stat(path.dirname(target)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输出目录不存在：${path.dirname(target)}`, {
      option: "--output",
      value: target,
    });
  }
  return target;
}

export async function writeResult(buffer, target) {
  try {
    await writeFile(target, buffer);
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `写入文件失败：${err?.message ?? err}`, {
      source: "agnes",
      reason: "write_failed",
      stage: "write",
      path: target,
    });
  }
  return { path: target, bytes: buffer.length };
}

const DATA_URI_RE = /^data:([^;,]+);base64,(.+)$/s;

// data URI 只回摘要（`data:<mime>;base64,<长度>bytes`）：base64 原文会灌爆 stdout，
// 还会把参考图像素内容带进命令输出（§3.4 与 §9.7）
export function summarizeRef(value) {
  const match = DATA_URI_RE.exec(value);
  if (match === null) return value;
  return `data:${match[1]};base64,${match[2].length}bytes`;
}

export function summarizeRefs(values) {
  return values.map(summarizeRef);
}
