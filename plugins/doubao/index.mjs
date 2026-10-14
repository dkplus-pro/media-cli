import { analyzeMusicWithDoubao } from "./lib/analysis.mjs";
import { locateGridWithDoubao } from "./lib/grid-locate.mjs";
import { transcribeWithDoubao } from "./lib/transcribe.mjs";

export default {
  name: "doubao",
  version: "0.2.0",
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
            "豆包模型 id（取自 --model 或环境变量 DOUBAO_TRANSCRIBE_MODEL，无内置默认值）",
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
    {
      name: "doubao-music-analysis",
      description:
        "音乐理解分析，输出 JSON 音乐描述（风格/情感/BPM/调性/乐器/分段结构/视频适用场景/记忆点；长曲自动切段并发+合并，支持文件与文件夹批量）",
      options: [
        { flags: "--input <path>", description: "输入音频/视频路径或文件夹（批量）" },
        {
          flags: "--output <path>",
          description:
            "输出 JSON 路径（单文件默认 <input>.music.json；文件夹默认 ./music-analysis）",
        },
        {
          flags: "--model <id>",
          description:
            "豆包模型 id（取自 --model 或环境变量 DOUBAO_TRANSCRIBE_MODEL，无内置默认值）",
        },
        {
          flags: "--segment-seconds <n>",
          description: "长曲切段目标时长秒（默认 180，范围 60–300；≤300s 整曲单请求）",
        },
        { flags: "--concurrency <n>", description: "并发请求数（默认 4，范围 1–8）" },
        { flags: "--recursive", description: "文件夹递归枚举" },
      ],
      handler: analyzeMusicWithDoubao,
    },
    {
      name: "doubao-grid-locate",
      description:
        "视觉模型定位宫格分镜：给整张分镜/漫画页的每一格输出像素矩形（cells JSON 可直接喂 media-grid-caption --cells，需 DOUBAO_API_KEY）",
      options: [
        { flags: "--input <path>", description: "单张宫格图（png/jpg/jpeg/webp；目录会被拒）" },
        {
          flags: "--model <id>",
          description:
            "豆包视觉模型 id（取自 --model 或环境变量 DOUBAO_VISION_MODEL，无内置默认值）",
        },
        {
          flags: "--expected <n>",
          description:
            "提示模型本页应有的格数（如 4/6/9），写进 prompt 提高检出一致性；与实际检出数不符会附 E_CELL_COUNT_MISMATCH 警告（不失败）",
        },
        {
          flags: "--max-side <n>",
          description:
            "送模型前把图片最长边缩到 n 像素以内（默认 1568，范围 256-4096；降采样后会统一重编码为 JPEG q82，实测 data URI 从 8.74MB 降到 0.40MB）。" +
            "注意：**瘦身只降传输失败面，不降耗时**（实测 --max-side 512 与默认一样慢）。输出的 cells/image 坐标一律是**原图像素**，data.scale/data.sent 记录实际缩放",
        },
        {
          flags: "--timeout <ms>",
          description:
            "单次请求超时毫秒（范围 1000-1800000；本命令默认 300000，比转写的 120000 高一个量级）。" +
            "实测单页 2048x2048 分镜 181.8s / 329.6s —— 慢是 provider 侧的，329.6s 已过 300s 线，慢页建议 --timeout 360000。" +
            "优先级：--timeout > DOUBAO_TIMEOUT_MS > 本命令默认 300000",
        },
        {
          flags: "--output <path>",
          description:
            "把 cells JSON 落盘（缺省只回显在 stdout 的 data 里）；产物可人工改完再喂 media-grid-caption --cells",
        },
      ],
      handler: locateGridWithDoubao,
    },
  ],
};
