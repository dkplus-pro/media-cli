import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

function malformed(file, reason, raw) {
  return cliError("E_PROVIDER_ERROR", `人脸检测输出无法解析：${reason}`, {
    source: "vision",
    file,
    reason: "malformed",
    raw: String(raw ?? "").slice(0, 400),
  });
}

function finiteNumber(value, key, file, raw) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw malformed(file, `字段 ${key} 不是数字`, raw);
  return n;
}

// Swift stderr 的 "E:<message>" 行 → 可读失败原因（对齐 media-cutout/lib/runner.mjs:18）
export function reasonFromStderr(stderr, fallback) {
  return /^E:(.+)$/m.exec(stderr)?.[1]?.trim() || String(fallback);
}

// stdout 契约：一行 {"width":W,"height":H,"faces":[{x,y,w,h,confidence,quality}]}
// 坐标已是**像素 + 左上原点**（Swift 侧做过 Y 轴翻转与 EXIF 摆正）
export function parseFacesOutput(stdout, file = "") {
  const raw = String(stdout ?? "");
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .pop();
  if (!line) throw malformed(file, "输出为空", raw);
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    throw malformed(file, "不是合法 JSON", raw);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw malformed(file, "根节点不是对象", raw);
  }
  const width = finiteNumber(payload.width, "width", file, raw);
  const height = finiteNumber(payload.height, "height", file, raw);
  if (width <= 0 || height <= 0) throw malformed(file, "宽高非正数", raw);
  if (!Array.isArray(payload.faces)) throw malformed(file, "faces 不是数组", raw);

  const faces = [];
  for (const [i, item] of payload.faces.entries()) {
    if (typeof item !== "object" || item === null) {
      throw malformed(file, `faces[${i}] 不是对象`, raw);
    }
    const confidence = finiteNumber(item.confidence ?? 1, `faces[${i}].confidence`, file, raw);
    faces.push({
      x: finiteNumber(item.x, `faces[${i}].x`, file, raw),
      y: finiteNumber(item.y, `faces[${i}].y`, file, raw),
      w: finiteNumber(item.w, `faces[${i}].w`, file, raw),
      h: finiteNumber(item.h, `faces[${i}].h`, file, raw),
      confidence,
      // faceCaptureQuality 在 Revision3 下常为 null：缺失即 null，不参与过滤
      quality: item.quality === null || item.quality === undefined ? null : Number(item.quality),
    });
  }
  return { width, height, faces };
}

// 跑一次 Swift 检测器：exit≠0 → E_PROVIDER_ERROR（details.source = "vision"），stderr 的 E: 文本进 message
export async function detectFaces(bin, input) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(bin, [input], {
      encoding: "utf8",
      timeout: 2 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    throw cliError(
      "E_PROVIDER_ERROR",
      `人脸检测失败：${reasonFromStderr(stderr, err?.message ?? err)}`,
      { source: "vision", file: input, stderr: stderr.slice(-400) },
    );
  }
  return parseFacesOutput(stdout, input);
}
