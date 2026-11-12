import { runImage } from "./lib/image.mjs";
import { runMusic } from "./lib/music.mjs";
import { runSpeech } from "./lib/speech.mjs";
import { runVideo } from "./lib/video.mjs";
import { runVideoRegen } from "./lib/video-regen.mjs";

export default {
  name: "minimax",
  version: "0.1.0",
  commands: [
    {
      name: "minimax-speech",
      description:
        "MiniMax 语音合成（默认 speech-2.8-hd / female-shaonv；不传 audio_setting，hex 音频落盘为 mp3）",
      options: [
        { flags: "--text <text>", description: "待合成文本（必填，最长 10000 字符）" },
        {
          flags: "--voice <id>",
          description: "系统音色 id（默认 female-shaonv，如 male-qn-qingse）",
        },
        { flags: "--speed <n>", description: "语速 0.5–2（默认 1）" },
        { flags: "--vol <n>", description: "音量 (0,10]（默认 1）" },
        { flags: "--pitch <n>", description: "音调整数 -12~12（默认 0）" },
        {
          flags: "--emotion <e>",
          description: "情绪：happy|sad|angry|fearful|disgusted|surprised|calm|fluent|whisper",
        },
        {
          flags: "--model <id>",
          description: "模型（默认 speech-2.8-hd，可由 MINIMAX_SPEECH_MODEL 覆盖）",
        },
        {
          flags: "--output <path>",
          description: "输出 mp3 路径（默认 ./minimax-speech-<时间戳>.mp3）",
        },
      ],
      handler: runSpeech,
    },
    {
      name: "minimax-music",
      description:
        "MiniMax 音乐生成（music-3.0 同步接口通常 >30s；不传 audio_setting / stream / output_format）",
      options: [
        {
          flags: "--prompt <text>",
          description: "风格/情绪/场景描述（--instrumental 时必填，≤2000 字符）",
        },
        {
          flags: "--lyrics <text>",
          description: "歌词（非纯音乐必填，或改用 --lyrics-optimizer；≤3500 字符）",
        },
        { flags: "--instrumental", description: "纯音乐（is_instrumental:true，歌词可省）" },
        {
          flags: "--lyrics-optimizer",
          description: "按 prompt 自动生成歌词（lyrics_optimizer:true）",
        },
        {
          flags: "--model <id>",
          description: "模型（默认 music-3.0，可由 MINIMAX_MUSIC_MODEL 覆盖）",
        },
        {
          flags: "--output <path>",
          description: "输出 mp3 路径（默认 ./minimax-music-<时间戳>.mp3）",
        },
        { flags: "--timeout <ms>", description: "整曲超时（默认 600000；全曲约 10MB）" },
      ],
      handler: runMusic,
    },
    {
      name: "minimax-video",
      description:
        "MiniMax 文生/图生/多模态参考生视频（v2 接口；H3 5s/768P 实测约 118s、H3-Max 同档约 10s，成片自带音轨，阻塞轮询后下载）",
      options: [
        { flags: "--prompt <text>", description: "视频描述（必填，≤7000 字符）" },
        {
          flags: "--first-frame <pathOrUrl>",
          description:
            "首帧图（图生视频）：本地文件读成 data URI 内联（jpeg/png/webp/heic/heif、每边 [256,5760]、宽高比 [0.4,2.5]、≤30MB），也可给 http(s) 或 mm_file:// URL；此模式下 ratio 恒为 adaptive",
        },
        {
          flags: "--last-frame <pathOrUrl>",
          description: "尾帧图（必须与 --first-frame 成对；provider 提交期不校验，插件本地拦）",
        },
        {
          flags: "--ref-image <pathsOrUrls...>",
          description: "参考图（多模态参考生视频，≤9 张；与 --first-frame/--last-frame 互斥）",
        },
        {
          flags: "--ref-video <pathsOrUrls...>",
          description:
            "参考视频（≤3 段、单段 [2,15]s、总 ≤15s、mp4/mov、≤50MB；时长/帧率未本地校验）",
        },
        {
          flags: "--ref-audio <pathsOrUrls...>",
          description: "参考音频（≤3 段、单段 [2,15]s、wav/mp3、≤15MB；可单独用不配参考图）",
        },
        {
          flags: "--aigc-watermark",
          description: "给成片加 AIGC 标识水印（默认关，与 provider 默认一致）",
        },
        {
          flags: "--prompt-expansion <mode>",
          description:
            "提示词扩写档位 disabled|balanced|quality，**仅 MiniMax-H3-Max 支持**（H3 传 extra 会被 provider 拒）",
        },
        {
          flags: "--model <id>",
          description: "MiniMax-H3（默认）| MiniMax-H3-Max，可由 MINIMAX_VIDEO_MODEL 覆盖",
        },
        { flags: "--duration <sec>", description: "时长秒（H3 4–15，H3-Max 5–15；默认 5）" },
        { flags: "--resolution <r>", description: "H3：768P|2K，H3-Max：480P|768P（默认 768P）" },
        {
          flags: "--ratio <r>",
          description:
            "21:9|16:9|4:3|1:1|3:4|9:16|adaptive（纯文生视频必填具体比例、默认 16:9；带图时恒为 adaptive，参考模式默认 adaptive）",
        },
        { flags: "--poll-interval <ms>", description: "轮询间隔（默认 5000）" },
        { flags: "--timeout <ms>", description: "提交+轮询+下载总预算（默认 900000）" },
        {
          flags: "--output <path>",
          description: "输出 mp4 路径（默认 ./minimax-video-<时间戳>.mp4）",
        },
      ],
      handler: runVideo,
    },
    {
      name: "minimax-video-regen",
      description:
        "MiniMax H3 视频再生为 2K（POST /v2/video_regeneration：把 H3 的 768P 成片升 2K；--source-task-id 或 --base-video 二选一，resolution 固定 2K，阻塞轮询后下载）",
      options: [
        {
          flags: "--source-task-id <id>",
          description:
            "按 768P 任务 ID 再生（与 --base-video 二选一）：须为当前账号 7 天内、status=succeeded 的 H3 768P 任务，服务端自动回填 prompt/素材",
        },
        {
          flags: "--base-video <pathOrUrl>",
          description:
            "按 768P 源视频再生（与 --source-task-id 二选一，须配 --prompt）：本地 mp4/mov 读成 data URI 内联，也可 http(s) 或 mm_file://；源视频须是 H3 的 768P 成片，不支持任意视频超分",
        },
        {
          flags: "--prompt <text>",
          description:
            "再生文本（--base-video 模式必填、≤7000 字符；--source-task-id 模式不要传，服务端自动回填）",
        },
        {
          flags: "--aigc-watermark",
          description: "给 2K 成片加 AIGC 标识水印（默认关，与 provider 默认一致）",
        },
        {
          flags: "--model <id>",
          description:
            "默认 MiniMax-H3，可由 MINIMAX_VIDEO_REGEN_MODEL 覆盖（部分网关的再生模型名为 MiniMax-H3-Regeneration）",
        },
        { flags: "--poll-interval <ms>", description: "轮询间隔（默认 5000）" },
        { flags: "--timeout <ms>", description: "提交+轮询+下载总预算（默认 900000）" },
        {
          flags: "--output <path>",
          description: "输出 mp4 路径（默认 ./minimax-video-regen-<时间戳>.mp4）",
        },
      ],
      handler: runVideoRegen,
    },
    {
      name: "minimax-image",
      description:
        "MiniMax H3 文生图/图片编辑（MiniMax-H3-Image，同步出图；默认 1024x1024/jpeg；--ref 1–16 张走 /v1/images/edits）",
      options: [
        { flags: "--prompt <text>", description: "画面描述（必填，1–32000 字符）" },
        {
          flags: "--ref <pathsOrUrls...>",
          description:
            "参考图 1–16 张（本地文件读成 data URI，也收 http(s) 与 mm_file://；传了即走 /v1/images/edits 图生图/编辑）",
        },
        {
          flags: "--size <WxH|auto>",
          description:
            "输出尺寸（默认 1024x1024；WxH 要求面积 655,360–20,000,000 px、比例 1:3–3:1；auto 时由 provider 定，provider 默认 4K）",
        },
        {
          flags: "--aspect-ratio <X:Y|auto>",
          description: "宽高比 X:Y 或 auto（仅 --size auto/省略时可用，与显式 WxH 互斥）",
        },
        {
          flags: "--area <1K|2K|4K>",
          description: "目标像素档 1K/2K/4K（provider 默认 4K；仅 --size auto/省略时可用）",
        },
        {
          flags: "--disable-prompt-enhanced",
          description: "关闭提示词增强（需显式比例：--size WxH 或 auto + --aspect-ratio X:Y）",
        },
        {
          flags: "--output-format <png|jpeg|jpg|webp>",
          description: "输出格式（默认 jpeg；jpg 归一为 jpeg）",
        },
        {
          flags: "--output-compression <0-100>",
          description: "输出压缩 0–100（整数，provider 默认 95；仅 jpeg/webp 有意义，png 忽略）",
        },
        {
          flags: "--aigc-watermark",
          description: "给成图加 AIGC 标识水印（默认关，与 provider 默认一致）",
        },
        {
          flags: "--model <id>",
          description:
            "MiniMax-H3-Image（默认）| MiniMax-H3-Image-Highspeed，可由 MINIMAX_IMAGE_MODEL 覆盖",
        },
        {
          flags: "--timeout <ms>",
          description: "请求+下载超时（默认 600000；实测 1024² 约 8s、4096² 约 13s）",
        },
        {
          flags: "--output <path>",
          description: "输出图片路径（默认 ./minimax-image-<时间戳>.<output_format 扩展名>）",
        },
      ],
      handler: runImage,
    },
  ],
};
