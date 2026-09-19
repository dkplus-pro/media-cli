import commands from "./lib/commands.mjs";

export default {
  name: "suno-music",
  version: "0.1.0",
  commands: [
    {
      name: "suno-gen",
      description: "Suno 文生音乐（--prompt 灵感 或 --lyrics 自定义歌词，二选一）",
      options: [
        { flags: "--prompt <text>", description: "灵感描述（灵感模式）" },
        { flags: "--lyrics <text>", description: "自定义歌词（自定义模式，可与 --tags 搭配）" },
        { flags: "--tags <tags>", description: "风格标签（仅自定义模式生效）" },
        { flags: "--title <title>", description: "歌曲标题" },
        {
          flags: "--model <model>",
          description: "chirp-hawk|chirp-hawk-wild|chirp-goose（默认 chirp-hawk）",
        },
        { flags: "--instrumental", description: "生成纯音乐" },
        { flags: "--no-wait", description: "只提交不等待，返回 taskIds" },
        { flags: "--timeout <sec>", description: "等待超时秒数（默认 600）" },
        {
          flags: "--output <path>",
          description: "下载目标（默认 ./suno-<taskId>.mp3；两首时自动 -1/-2）",
        },
      ],
      handler: commands.gen,
    },
    {
      name: "suno-sound",
      description: "Suno 文生音效（模型 chirp-crow / chirp-fenix）",
      options: [
        { flags: "--text <text>", description: "音效描述（作为标题）" },
        { flags: "--tags <tags>", description: "风格标签" },
        { flags: "--loop", description: "生成可循环音效" },
        { flags: "--model <model>", description: "chirp-crow|chirp-fenix（默认由服务端决定）" },
        { flags: "--no-wait", description: "只提交不等待，返回 taskIds" },
        { flags: "--timeout <sec>", description: "等待超时秒数（默认 600）" },
        { flags: "--output <path>", description: "下载目标（默认 ./suno-<taskId>.mp3）" },
      ],
      handler: commands.sound,
    },
    {
      name: "suno-task",
      description: "查询 Suno 任务状态",
      options: [{ flags: "--id <taskId>", description: "任务 ID（suno-gen 返回的 taskIds 之一）" }],
      handler: commands.task,
    },
    {
      name: "suno-download",
      description: "补下载已完成任务的音频（mp3Url 限时 1 小时）",
      options: [
        { flags: "--id <taskId>", description: "任务 ID" },
        { flags: "--output <path>", description: "下载目标路径" },
      ],
      handler: commands.download,
    },
    {
      name: "suno-balance",
      description: "查询 Suno 积分余额",
      handler: commands.balance,
    },
  ],
};
