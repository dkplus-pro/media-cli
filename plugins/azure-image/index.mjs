import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateImage } from "./lib/client.mjs";
import { loadConfig } from "./lib/env.mjs";
import { cliError } from "./lib/errors.mjs";

const SIZE_RE = /^\d{3,4}x\d{3,4}$/;
const QUALITIES = ["auto", "low", "medium", "high"];

async function imageGen(ctx, args) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  const size = args.size ?? "1024x1024";
  if (!SIZE_RE.test(size)) {
    throw cliError("E_INVALID_OPTION", `--size 格式非法：${size}（如 1024x1024）`, {
      option: "--size",
      value: size,
    });
  }
  const refs = [];
  for (const refPath of args.ref ?? []) {
    const info = await stat(refPath).catch(() => null);
    if (!info?.isFile()) {
      throw cliError("E_MISSING_ARGUMENT", `参考图不存在：${refPath}`, {
        option: "--ref",
        value: refPath,
      });
    }
    refs.push({ data: await readFile(refPath), name: path.basename(refPath) });
  }

  // 配置校验必须先于任何网络请求
  const config = loadConfig();
  const quality = args.quality ?? config.quality;
  if (!QUALITIES.includes(quality)) {
    throw cliError("E_INVALID_OPTION", `--quality 仅支持 ${QUALITIES.join("|")}`, {
      option: "--quality",
      value: quality,
    });
  }

  const result = await generateImage(config, { prompt: args.prompt, size, quality, refs });

  const ext = config.outputFormat;
  const output = path.resolve(
    ctx.cwd,
    args.output ?? `generated-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`,
  );
  const parent = await stat(path.dirname(output)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输出目录不存在：${path.dirname(output)}`, {
      option: "--output",
      value: output,
    });
  }
  const buf = Buffer.from(result.b64, "base64");
  await writeFile(output, buf);
  ctx.logger.info(`已写入 ${output}`);

  return {
    path: output,
    bytes: buf.length,
    format: config.outputFormat,
    size,
    ...(result.revisedPrompt !== undefined ? { revisedPrompt: result.revisedPrompt } : {}),
    account: result.account,
  };
}

export default {
  name: "azure-image",
  version: "0.1.0",
  commands: [
    {
      name: "image-gen",
      description: "Azure gpt-image-2 生图（--ref 参考图走 edits，纯文案走 generations）",
      options: [
        { flags: "--prompt <text>", description: "生图文案" },
        { flags: "--ref <paths...>", description: "参考图路径（可多个，走 edits 端点）" },
        { flags: "--size <WxH>", description: "尺寸（默认 1024x1024）" },
        {
          flags: "--output <path>",
          description: "输出图片路径（默认 ./generated-<时间戳>.<格式>）",
        },
        {
          flags: "--quality <q>",
          description: "auto|low|medium|high（默认取 AZURE_IMAGE_QUALITY）",
        },
      ],
      handler: imageGen,
    },
  ],
};
