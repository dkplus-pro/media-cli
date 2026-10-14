// 宫格定位 prompt（§6.1）。单独一个文件：调 prompt 不动逻辑。
// 实测坑位：VLM 爱给 0–1 归一化小数、爱把倾斜面板的框算到画布外，所以像素/原点/越界三件事各说一遍。

const SCHEMA_HINT = `{
  "cells": [
    { "index": 0, "x": 12, "y": 34, "w": 620, "h": 640 }
  ],
  "image": { "width": WIDTH, "height": HEIGHT },
  "source": "vision"
}`;

// 失败重试时追加的更严指令（§6.1：第二次要求「只输出 JSON」）
export const STRICT_RETRY_INSTRUCTION =
  "\n\n上一次输出不是合法 JSON。这次**只输出一个 JSON 对象**：不要任何前后说明文字、" +
  "不要 markdown 代码围栏、不要注释、不要尾逗号。第一个字符必须是 {，最后一个字符必须是 }。";

// 像素坐标 + 真实尺寸写进 prompt：比让模型自己猜画布大小稳得多。
// original（F1）：图片被降采样过时的原图尺寸 —— 必须说清「坐标基于你看到的这张缩小图」，
// 否则模型会去猜原图像素，调用方那一步放大就会把坐标算飞。
export function buildGridPrompt({ expected, width, height, original } = {}) {
  const W = Number.isInteger(width) && width > 0 ? width : 0;
  const H = Number.isInteger(height) && height > 0 ? height : 0;
  const known = W > 0 && H > 0;
  const downscaled =
    known &&
    Number.isInteger(original?.width) &&
    Number.isInteger(original?.height) &&
    (original.width !== W || original.height !== H);
  const schema = SCHEMA_HINT.replace("WIDTH", String(W || 1024)).replace(
    "HEIGHT",
    String(H || 1024),
  );
  const bounds = known
    ? `必须满足 0 <= x、0 <= y、x + w <= ${W}、y + h <= ${H}。`
    : "必须全部为非负整数，且 x+w、y+h 不得超过图像宽高。";
  return `你是漫画/分镜页的宫格定位器。请找出这张图里每一格分镜面板（panel）的矩形边界。

图像${known ? `实际尺寸为 ${W}x${H} 像素` : "尺寸未知"}。${
    downscaled
      ? `\n这张图由 ${original.width}x${original.height} 的原图按比例**缩小**后送来：坐标与 image 字段都必须以**你看到的这张 ${W}x${H} 图**为准，禁止按原图尺寸或肉眼估计的分辨率来填。`
      : ""
  }${expected ? `\n本页预期有 ${expected} 格，请按此核对你的检出数量。` : ""}

只输出一个 JSON 对象，形如：
${schema}

硬性要求：
- 坐标一律是**像素整数**，原点在图像**左上角**；x/y 是该格左上角，w/h 是该格宽高。禁止输出 0–1 的归一化小数，禁止百分比。
- ${bounds}
- image.width / image.height 填**你看到的这张图**的像素尺寸${known ? `（即 ${W} 与 ${H}，不是任何更高分辨率的原图）` : ""}。
- cells 按阅读顺序编号：自上而下分行、同一行内自左向右，index 从 0 开始连续递增，不要跳号。
- 面板带倾斜、圆角或描边不规则时，给**能装下该格内容的矩形**；宁可向内缩几像素，也不要越出图像边界或与相邻格大幅重叠。
- 只框画面内容格，不要把页码、分镜编号文字、页面留白当成一格。
- 不要输出 text、字幕、描述等额外字段。
- source 固定填 "vision"。`;
}
