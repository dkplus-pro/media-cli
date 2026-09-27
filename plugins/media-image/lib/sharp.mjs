import { cliError } from "./errors.mjs";

let sharpPromise;

// 懒加载 sharp：不拖慢其他命令启动；安装损坏时给结构化错误而非插件加载失败
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
