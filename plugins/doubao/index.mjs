import { transcribeWithDoubao } from "./lib/transcribe.mjs";

export default {
  name: "doubao",
  version: "0.1.0",
  commands: [
    {
      name: "doubao-media-transcribe",
      description:
        "音频/视频转 SRT 字幕或纯文本（火山方舟 doubao 多模态，长音频静音对齐分段并发，需 DOUBAO_API_KEY）",
      options: [
        { flags: "--input <path>", description: "输入音频/视频路径" },
        { flags: "--output <path>", description: "输出路径（默认 <input>.<format>）" },
        { flags: "--format <format>", description: "srt|txt（默认 srt）" },
        {
          flags: "--model <id>",
          description:
            "豆包模型 id（默认取 DOUBAO_TRANSCRIBE_MODEL，兜底 doubao-seed-2-0-mini-260428）",
        },
        { flags: "--language <code>", description: "转写语言提示（默认 auto，跟随音频原语言）" },
        { flags: "--prompt <text>", description: "附加转写要求（专有名词、口音、领域提示）" },
        {
          flags: "--segment-seconds <n>",
          description: "单段目标时长秒（默认 30，范围 10–120；硬上限自动取 1.5 倍）",
        },
        { flags: "--concurrency <n>", description: "分段并发请求数（默认 4，范围 1–8）" },
      ],
      handler: transcribeWithDoubao,
    },
  ],
};
