import { outputPathOf, writeOutput } from "./audio.mjs";
import { loadConfig } from "./config.mjs";
import { resolveVideoMedia } from "./video-media.mjs";
import { buildVideoBody, parseVideoParams } from "./video-params.mjs";
import { createVideoTask, downloadVideoFile, hasValue, pollVideoTask } from "./video-task.mjs";

// minimax-video 主入口：参数与请求体在 lib/video-params.mjs，多模态媒体解析与本地预检在
// lib/video-media.mjs，任务生命周期（提交 → 轮询 → 下载）在 lib/video-task.mjs（与再生命令共用）。
// 再导出两个纯函数：既给 runVideo 用，也让单测继续从本模块 import。
export { buildVideoBody, parseVideoParams };

const CREATE_PATH = "/v2/video_generation";
const SOURCE = "minimax-video";

export async function runVideo(ctx, args) {
  const config = loadConfig();
  const input = parseVideoParams(args, config);
  // 媒体在提交任务前全部读完并本地预检：内联失败/尺寸越界都不该白跑一次任务
  const media = await resolveVideoMedia(args, ctx.cwd);
  if (input.ratioIgnored) {
    ctx.warnings.add({
      code: "E_RATIO_IGNORED",
      message: `图生视频的宽高比由输入图片决定，--ratio ${args.ratio} 会被 provider 忽略并按 adaptive 处理`,
      plugin: "minimax",
    });
  }
  const deadline = Date.now() + input.timeoutMs;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `minimax-video-${stamp}.mp4`;
  // 输出目录先预检：路径问题在提交任务前失败，不白烧额度
  await outputPathOf(ctx, args.output, defaultName);

  const taskId = await createVideoTask(config, {
    source: SOURCE,
    path: CREATE_PATH,
    body: buildVideoBody(input, media),
    deadline,
  });
  ctx.logger.info(
    `minimax-video 任务已提交：${taskId}（实测 H3 5s/768P 约 118s、H3-Max 同档约 10s，轮询中）`,
  );

  const { task, url } = await pollVideoTask(config, {
    source: SOURCE,
    taskId,
    pollIntervalMs: input.pollIntervalMs,
    deadline,
  });
  const buf = await downloadVideoFile(config, { source: SOURCE, url, taskId, deadline });
  const output = await writeOutput(ctx, args.output, defaultName, buf);

  return {
    path: output,
    bytes: buf.length,
    model: input.model,
    mode: input.mode,
    taskId,
    durationSec: input.durationSec,
    resolution: input.resolution,
    ratio: input.ratio,
    // 只回摘要：内联媒体的 base64 绝不进 stdout
    ...(Object.keys(media.media).length === 0 ? {} : { media: media.media }),
    ...(hasValue(task.created_at) ? { createdAt: task.created_at } : {}),
    ...(hasValue(task.updated_at) ? { updatedAt: task.updated_at } : {}),
    ...(hasValue(task.ratio) ? { actualRatio: task.ratio } : {}),
    ...(hasValue(task.usage) ? { usage: task.usage } : {}),
  };
}
