import path from "node:path";
import { cliError } from "./errors.mjs";

export const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const EXT_TO_FORMAT = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
};

// 按扩展名解析 sharp 格式名（保持原格式输出，不做转码）
export function resolveImageFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const format = EXT_TO_FORMAT[ext];
  if (!format) {
    throw cliError(
      "E_INVALID_OPTION",
      `不支持的文件类型：${filePath}（仅 ${SUPPORTED_EXTENSIONS.join("/")}）`,
      { option: "--input", value: filePath },
    );
  }
  return format;
}
