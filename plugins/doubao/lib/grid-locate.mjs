import { readFile, writeFile } from "node:fs/promises";
import { chatWithRetry } from "./ark.mjs";
import { GRID_LOCATE_TIMEOUT_MS, getConfig, VISION_MODEL_VAR } from "./config.mjs";
import { cliError } from "./errors.mjs";
import {
  mimeOf,
  parseExpected,
  parseTimeoutMs,
  readImageSize,
  requireString,
  resolveSingleFile,
} from "./grid-args.mjs";
import {
  DEFAULT_OVERLAP_LIMIT,
  parseMaxSide,
  prepareVisionImage,
  readDecodedSize,
  upscaleCellsToOriginal,
} from "./grid-image.mjs";
import { repairCellOverlaps } from "./grid-overlap.mjs";
import { buildGridPrompt, STRICT_RETRY_INSTRUCTION } from "./grid-prompt.mjs";
import { normalizeVisionCells, parseVisionJson, unparsableError } from "./grid-schema.mjs";

// 视觉模型定位宫格（media-24 / §6.1）：读图 → 降采样（并统一重编码 JPEG）→ data URI → chatWithRetry
// → 剥围栏解析 → §2 校验（缩小图坐标系）→ 放大回原图像素（F1）→ 薄条重叠清理（F2）→ data
// HTTP 层完全复用 lib/ark.mjs 的 chatWithRetry（内含重试与 extractText），不另写一遍。
// 入参解析与本地读图住在 lib/grid-args.mjs，重叠修复住在 lib/grid-overlap.mjs（300 行红线）。

async function askArk(config, { model, prompt, dataUri }) {
  const res = await chatWithRetry(config, {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  return res.text;
}

export async function locateGridWithDoubao(ctx, args) {
  const input = await resolveSingleFile(args.input === undefined ? "" : String(args.input));
  const expected = parseExpected(args.expected);
  const maxSide = parseMaxSide(args.maxSide);
  const output = args.output === undefined ? null : requireString(String(args.output), "--output");

  // 模型 id 必须在起网络请求之前定下来：缺 DOUBAO_VISION_MODEL 要干净地报 E_CONFIG 且不碰网络
  // 超时走本命令自己的默认（300s）：实测单页 181–330s，沿用转写的 120s 会把正常慢响应判成超时。
  // 优先级 --timeout > DOUBAO_TIMEOUT_MS > 命令默认（flag 必须能压过 env，否则 e2e/CI 没法临时收紧）
  const flagTimeout = parseTimeoutMs(args.timeout);
  const base = getConfig(process.env, { timeoutMs: GRID_LOCATE_TIMEOUT_MS });
  const config = flagTimeout === null ? base : { ...base, timeoutMs: flagTimeout };
  const model =
    args.model === undefined ? config.visionModel : requireString(String(args.model), "--model");
  if (!model) {
    throw cliError("E_CONFIG", `缺少视觉模型 id：设置 ${VISION_MODEL_VAR} 或用 --model 指定`, {
      var: VISION_MODEL_VAR,
      hint: "用 GET /models 里 status 非 Shutdown 且 input_modalities 含 image 的型号",
    });
  }

  const buffer = await readFile(input);
  const mime = mimeOf(input);
  const headerSize = readImageSize(buffer);
  // 原图尺寸是 §2 的口径（cells 与 image 都按它报），送模型的图只是它的等比缩小版
  const original = headerSize ?? (await readDecodedSize(buffer));
  const prepared = await prepareVisionImage(buffer, mime, original, maxSide);
  const dataUri = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`;
  const prompt = buildGridPrompt({
    expected,
    width: prepared.width,
    height: prepared.height,
    original: prepared.scale === 1 ? null : original,
  });
  if (prepared.resized) {
    const { width, height, bytes, originalBytes, encode } = prepared.resized;
    ctx.logger.info(
      `送模型前降采样 ${original.width}x${original.height} → ${width}x${height}` +
        `（scale=${prepared.scale}，重编码 ${encode}，data URI ${originalBytes} → ${bytes} 字节；` +
        `注意：瘦身不改变视觉耗时，慢是 provider 侧的事）`,
    );
  }

  let parsed = parseVisionJson(await askArk(config, { model, prompt, dataUri }));
  if (!parsed.ok) {
    // 只重试一次，并把 prompt 换成更硬的「只输出 JSON」
    ctx.logger.info("视觉模型输出不是合法 JSON，按更严指令重试一次");
    const again = await askArk(config, {
      model,
      prompt: prompt + STRICT_RETRY_INSTRUCTION,
      dataUri,
    });
    parsed = parseVisionJson(again);
    if (!parsed.ok) throw unparsableError(parsed.raw || again);
  }

  // 注意：这里的 actual* 是**缩小图**的尺寸 —— 模型看到的就是那张图，§2 校验也在这套坐标里做。
  const vision = normalizeVisionCells(parsed.value, {
    actualWidth: prepared.width,
    actualHeight: prepared.height,
  });
  const notes = [...(prepared.note ? [prepared.note] : [])];
  if (headerSize === null) {
    notes.push(
      original === null
        ? "本地未能解出图片像素尺寸，画布尺寸取自模型返回的 image 字段（未经交叉校验）"
        : "本地未能从文件头解出图片像素尺寸，画布尺寸取自 sharp 的解码结果",
    );
  }
  notes.push(...vision.notes);

  // F1 的关键一步：模型给的是缩小图的坐标，必须整体放大回原图像素（§2 冻结口径）。
  // image.width/height 同样报原图尺寸，绝不留 sent 尺寸在契约字段里。
  const upscaled =
    prepared.resized !== null &&
    Number.isInteger(original?.width) &&
    Number.isInteger(original?.height);
  const scaled = upscaled
    ? upscaleCellsToOriginal(vision.cells, prepared.resized.sx, prepared.resized.sy, original)
    : { cells: vision.cells, clamped: 0 };
  const image = upscaled ? { width: original.width, height: original.height } : vision.image;
  if (upscaled && scaled.clamped > 0) {
    notes.push(
      `有 ${scaled.clamped} 格放大回原图后溢出边界（取整误差），已内收到原图 ${original.width}x${original.height} 内`,
    );
  }

  // F2：放大取整必然让相邻格错开几像素 —— 在产出侧就修成互不重叠，别把兄弟命令的产物
  // 原样递过去让 media-grid-caption 反手一个 E_INVALID_OPTION 拒收（实测断点就在这一刀）。
  const repairedRes = repairCellOverlaps(scaled.cells, { limit: DEFAULT_OVERLAP_LIMIT });
  const cells = repairedRes.cells;
  if (repairedRes.repaired > 0) {
    notes.push(
      `有 ${repairedRes.repaired} 处相邻格重叠（放大回原图后的取整/描边抖动，薄边 ≤${repairedRes.limit}` +
        `）已在重叠区内切齐，几何未改动重叠区以外的部分`,
    );
    ctx.warnings.add({
      code: "E_CELL_OVERLAP_REPAIRED",
      message:
        `放大回原图后有 ${repairedRes.repaired} 处格子薄条重叠，已在重叠区内切齐` +
        `（data.overlapRepaired）。这是 --max-side 降采样 + 取整的固有产物，无需处理；` +
        `要更保守可增大 --max-side 或直接改用 media-grid-caption --cols/--rows 等分`,
      plugin: "doubao",
    });
  }
  if (repairedRes.remaining > 0) {
    // 修不动的大重叠：模型真的把两格框重了。留在产物里交给消费侧判定，但绝不静默
    notes.push(
      `另有 ${repairedRes.remaining} 组格子重叠幅度较大（薄边 >${repairedRes.limit}），未自动修复`,
    );
    ctx.warnings.add({
      code: "E_CELLS_OVERLAP",
      message:
        `视觉模型给出的格子里有 ${repairedRes.remaining} 组重叠幅度较大（不是放大取整能解释的）：` +
        `media-grid-caption 按 --max-overlap（默认 0.05，即本命令的修复窗口）分级 —— ` +
        "面积占比在阈值内只警告并照常渲染，超过才报 E_INVALID_OPTION。" +
        "请人工编辑 --output 的 cells JSON，或改用 --cols/--rows 等分，确认是刻意的分层版式可加 --allow-overlap",
      plugin: "doubao",
    });
  }
  if (prepared.resized) {
    notes.push(
      `模型是在 ${prepared.resized.width}x${prepared.resized.height} 的缩小图（--max-side ${maxSide}）上给的坐标，` +
        `已按 sx=${prepared.resized.sx} sy=${prepared.resized.sy} 放大回原图 ${original.width}x${original.height} 像素`,
    );
  }

  // F4：--expected 不再只是写进 prompt 的软提示 —— 数量不符必须留下警告（但不失败：模型可能确实找到别的格数）
  if (expected !== null && cells.length !== expected) {
    ctx.warnings.add({
      code: "E_CELL_COUNT_MISMATCH",
      message:
        `视觉模型给出 ${cells.length} 格，与 --expected ${expected} 不符：` +
        "可能漏格或多框（命令仍成功）。可核对 --output 的 JSON 后人工修正，再喂 media-grid-caption --cells",
      plugin: "doubao",
    });
  }

  const data = {
    cells,
    image,
    source: vision.source,
    model,
    // 审计用：scale=1 表示原图直送；<1 表示模型看到的是缩小图且坐标已放大回原图
    scale: prepared.scale,
    maxSide,
    timeoutMs: config.timeoutMs,
    // 被切齐的重叠数（0 = 一格都没动）；重叠修复这件事必须留在 data 里而不是只进 stderr
    overlapRepaired: repairedRes.repaired,
    ...(prepared.resized ? { sent: prepared.resized } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(expected ? { expected } : {}),
    input,
  };
  if (output !== null) {
    const payload = { cells, image, source: vision.source, model };
    await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    data.path = output;
    ctx.logger.info(`宫格定位结果已写入 ${output}（${cells.length} 格）`);
  }
  return data;
}
