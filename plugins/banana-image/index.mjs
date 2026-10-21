import { run } from "./lib/run.mjs";

export default {
  name: "banana-image",
  version: "0.1.0",
  commands: [
    {
      name: "banana-image-gen",
      description:
        "BananaRouter gpt-image-2 生图/改图（默认 quality=low、moderation=low、1024x1024、jpeg；--ref 走 /v1/images/edits，本地路径与 http(s) URL 可混传）",
      options: [
        { flags: "--prompt <text>", description: "生图/编辑文案（必填）" },
        {
          flags: "--ref <urlsOrPaths...>",
          description:
            "参考图，可多个：http(s) URL 由网关下载（本地无需先上传），本地文件读成 data URI 内联；混传时整请求走 JSON images",
        },
        {
          flags: "--size <WxH|auto>",
          description:
            "尺寸（默认 1024x1024；每边为 16 的倍数且 ≤3840，长短边比 ≤3:1，总像素 655360–8294400）",
        },
        {
          flags: "--quality <q>",
          description: "auto|low|medium|high（默认 low，可由 BANANA_IMAGE_QUALITY 覆盖）",
        },
        {
          flags: "--moderation <m>",
          description:
            "auto|low（默认 low，可由 BANANA_IMAGE_MODERATION 覆盖；只放宽模型侧额外过滤）",
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
