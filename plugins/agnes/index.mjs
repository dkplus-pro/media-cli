import { agnesImage, agnesVideo } from "./lib/commands.mjs";

export default {
  name: "agnes",
  version: "0.1.0",
  commands: [
    {
      name: "agnes-image",
      description:
        "Agnes 2.5 Flash 生图/改图（同步接口；--ref 支持本地文件自动转 base64，不用先上传 CDN）",
      options: [
        { flags: "--prompt <text>", description: "生图文案（必填，实测上限 10000 字符）" },
        {
          flags: "--size <tier|WxH>",
          description:
            "1K|2K|3K|4K 档位或 WIDTHxHEIGHT（默认 4K；档位=面积，4K/1:1=4096x4096。显式 WxH 会被降采样，实测 2048x1152 → 1312x736）",
        },
        {
          flags: "--ratio <name>",
          description:
            "比例 1:1|3:4|4:3|16:9|9:16|2:3|3:2|21:9（默认 1:1，与 WxH 形态的 --size 二选一）",
        },
        {
          flags: "--ref <pathOrUrl...>",
          description:
            "参考图，可多张（实测上限 6 张）：本地文件自动转 data URI，http(s) URL 原样透传；传了就走图生图（data.mode=i2i）",
        },
        {
          flags: "--format <url|b64>",
          description: "返回形态 url（默认）| b64（内联返回，不落 CDN）",
        },
        { flags: "--output <path>", description: "输出图片路径（默认 ./agnes-<时间戳>.png）" },
        {
          flags: "--model <id>",
          description: "模型 id（默认 AGNES_IMAGE_MODEL，内置 agnes-image-2.5-flash）",
        },
      ],
      handler: agnesImage,
    },
    {
      name: "agnes-video",
      description:
        "Agnes 2.5 Flash 生视频（提交 + 轮询；素材只收公网 URL，本地文件先跑 tencent-cos-upload）",
      options: [
        {
          flags: "--prompt <text>",
          description: "视频文案（必填；上限待实测，可用 <Picture N>/<Audio N> 引用素材）",
        },
        {
          flags: "--mode <mode>",
          description:
            "text|keyframe|reference（默认自动推断：有 --first-frame → keyframe，有 --images/--audios → reference，否则 text）",
        },
        {
          flags: "--seconds <4-12>",
          description: "时长整数秒（默认 5；provider 侧是字符串形态，已自动转换）",
        },
        { flags: "--aspect-ratio <name>", description: "21:9|16:9（默认）|4:3|1:1|3:4|9:16" },
        {
          flags: "--size <720P>",
          description: "分辨率（实测只支持 720P，其他值本地即拒——provider 直接 400）",
        },
        {
          flags: "--first-frame <url>",
          description: "首帧公网 URL（keyframe 与 --last-frame 成对必填）",
        },
        {
          flags: "--last-frame <url>",
          description: "尾帧公网 URL（keyframe 与 --first-frame 成对必填）",
        },
        {
          flags: "--images <urls...>",
          description:
            "参考图公网 URL，可多张（实测上限 5 张；本地路径会被拒，先 tencent-cos-upload）",
        },
        { flags: "--audios <urls...>", description: "参考音频公网 URL，可多个（实测上限 3 个）" },
        { flags: "--seed <n>", description: "随机种子（可选，0–2147483647，同 seed 可复现）" },
        {
          flags: "--no-wait",
          description: "只提交不轮询，data 返回 taskId（默认轮询到 completed 再下载）",
        },
        {
          flags: "--output <path>",
          description: "输出视频路径（默认 ./agnes-video-<ISO时间戳>.mp4）",
        },
        {
          flags: "--model <id>",
          description: "模型 id（默认 AGNES_VIDEO_MODEL，内置 agnes-video-2.5-flash）",
        },
      ],
      handler: agnesVideo,
    },
  ],
};
