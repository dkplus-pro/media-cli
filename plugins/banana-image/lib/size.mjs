import { cliError } from "./errors.mjs";

// BananaRouter 文档（2026-10-18）：
//   每边 ≤3840、必须是 16 的倍数、长短边比 ≤3:1、总像素 655360–8294400。
// 网关对非法 size 不报错而是静默降级成 2880x2880，所以必须客户端预检。
export const EDGE_MAX = 3840;
export const PIXELS_MIN = 655_360;
export const PIXELS_MAX = 8_294_400;
export const RATIO_MAX = 3;

const SIZE_RE = /^\d{3,4}x\d{3,4}$/;

export function parseSize(value = "1024x1024") {
  if (value === "auto") return value;
  if (!SIZE_RE.test(value)) {
    throw cliError("E_INVALID_OPTION", `--size 必须是 auto 或 WxH 格式（如 1024x1024）：${value}`, {
      option: "--size",
      value,
    });
  }
  const [width, height] = value.split("x").map(Number);
  for (const [edge, name] of [
    [width, "宽"],
    [height, "高"],
  ]) {
    if (edge % 16 !== 0) {
      throw cliError("E_INVALID_OPTION", `--size 的${name}必须是 16 的倍数：${value}`, {
        option: "--size",
        value,
        edge,
      });
    }
    if (edge > EDGE_MAX) {
      throw cliError("E_INVALID_OPTION", `--size 的${name}不能超过 ${EDGE_MAX}px：${value}`, {
        option: "--size",
        value,
        edge,
      });
    }
  }
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > RATIO_MAX) {
    throw cliError("E_INVALID_OPTION", `--size 长短边比不能超过 ${RATIO_MAX}:1：${value}`, {
      option: "--size",
      value,
      ratio,
    });
  }
  const pixels = width * height;
  if (pixels < PIXELS_MIN || pixels > PIXELS_MAX) {
    throw cliError(
      "E_INVALID_OPTION",
      `--size 总像素必须在 ${PIXELS_MIN}–${PIXELS_MAX} 之间：${value}（当前 ${pixels}）`,
      { option: "--size", value, pixels },
    );
  }
  return value;
}
