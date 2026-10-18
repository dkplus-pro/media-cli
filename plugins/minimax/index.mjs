import { runMusic } from "./lib/music.mjs";
import { runSpeech } from "./lib/speech.mjs";
import { runVideo } from "./lib/video.mjs";

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
        "MiniMax 文生视频（v2 接口；H3 5s/768P/16:9 实测约 118s，成片自带音轨，阻塞轮询后下载）",
      options: [
        { flags: "--prompt <text>", description: "视频描述（必填）" },
        {
          flags: "--model <id>",
          description: "MiniMax-H3（默认）| MiniMax-H3-Max，可由 MINIMAX_VIDEO_MODEL 覆盖",
        },
        { flags: "--duration <sec>", description: "时长秒（H3 4–15，H3-Max 5–15；默认 5）" },
        { flags: "--resolution <r>", description: "H3：768P|2K，H3-Max：480P|768P（默认 768P）" },
        {
          flags: "--ratio <r>",
          description: "21:9|16:9|4:3|1:1|3:4|9:16（默认 16:9；t2v 不支持 adaptive）",
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
  ],
};
