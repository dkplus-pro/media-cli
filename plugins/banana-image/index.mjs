import { run } from "./lib/run.mjs";

export default {
  name: "banana-image",
  version: "0.1.0",
  commands: [
    {
      name: "banana-image-gen",
      description:
        "BananaRouter gpt-image-2 生图/改图（默认 quality=high、1024x1024；--ref 传本地参考图走 edits）",
      options: [
        { flags: "--prompt <text>", description: "生图/编辑文案（必填）" },
        {
          flags: "--ref <paths...>",
          description: "本地参考图路径，可多个（仅 jpg/jpeg/png/webp，走 /v1/images/edits）",
        },
        {
          flags: "--size <WxH|auto>",
          description:
            "尺寸（默认 1024x1024；每边为 16 的倍数且 ≤3840，长短边比 ≤3:1，总像素 655360–8294400）",
        },
        {
          flags: "--quality <q>",
          description: "auto|low|medium|high（默认 high，可由 BANANA_IMAGE_QUALITY 覆盖）",
        },
        { flags: "--output <path>", description: "输出图片路径（默认 ./banana-<时间戳>.<格式>）" },
        {
          flags: "--model <id>",
          description: "模型 id（默认 gpt-image-2，可由 BANANA_IMAGE_MODEL 覆盖）",
        },
      ],
      handler: run,
    },
  ],
};
