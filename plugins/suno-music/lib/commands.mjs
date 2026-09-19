import path from "node:path";
import { createSunoClient } from "./client.mjs";
import { cliError, getConfig } from "./config.mjs";
import { downloadFile, resolveOutputPath } from "./download.mjs";
import { pollTasks } from "./poll.mjs";

const GEN_MODELS = ["chirp-hawk", "chirp-hawk-wild", "chirp-goose"];
const SOUND_MODELS = ["chirp-crow", "chirp-fenix"];

function requireOption(value, option) {
  if (value === undefined || String(value).trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", `缺少必填 ${option}`, { option });
  }
  return String(value);
}

function resolveTimeoutMs(args, config) {
  if (args.timeout === undefined) return config.timeoutMs;
  const sec = Number(args.timeout);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw cliError("E_INVALID_OPTION", `--timeout 必须是正数秒，得到：${args.timeout}`, {
      option: "--timeout",
      value: args.timeout,
    });
  }
  return sec * 1000;
}

// 提交 →（--no-wait 提前返回）→ 轮询 → 按提交顺序下载；任一落盘即成功，全失败才抛错
async function runSubmitFlow(ctx, args, submit) {
  const config = getConfig();
  const client = createSunoClient(config);
  const taskIds = await submit(client);
  if (args.wait === false) return { taskIds };

  const { completed, failed } = await pollTasks(client, taskIds, {
    intervalMs: config.pollIntervalMs,
    timeoutMs: resolveTimeoutMs(args, config),
    logger: ctx.logger,
  });

  const tracks = [];
  const downloadFailures = [];
  for (let i = 0; i < completed.length; i++) {
    const { taskId, task } = completed[i];
    const target = resolveOutputPath(args.output, i, completed.length, taskId, ctx.cwd);
    try {
      const file = await downloadFile(task.audioUrl, target);
      tracks.push({
        taskId,
        customId: task.customId,
        title: task.title,
        durationSec: task.durationSec,
        path: file.path,
        bytes: file.bytes,
      });
    } catch {
      downloadFailures.push({ taskId, reason: "download_failed" });
    }
  }
  const allFailed = [...failed, ...downloadFailures];
  if (tracks.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "全部任务失败或未能落盘", {
      taskIds,
      failed: allFailed,
    });
  }
  return { tracks, failed: allFailed };
}

async function gen(ctx, args) {
  const hasPrompt = typeof args.prompt === "string" && args.prompt.trim() !== "";
  const hasLyrics = typeof args.lyrics === "string" && args.lyrics.trim() !== "";
  if (!hasPrompt && !hasLyrics) {
    throw cliError("E_MISSING_ARGUMENT", "suno-gen 需要 --prompt 或 --lyrics 之一", {
      option: "--prompt|--lyrics",
    });
  }
  if (hasPrompt && hasLyrics) {
    throw cliError("E_INVALID_OPTION", "--prompt 与 --lyrics 互斥，只传其一", {
      options: ["--prompt", "--lyrics"],
    });
  }
  const model = args.model ?? "chirp-hawk";
  if (!GEN_MODELS.includes(model)) {
    throw cliError("E_INVALID_OPTION", `--model 仅支持 ${GEN_MODELS.join("|")}`, {
      option: "--model",
      value: model,
    });
  }
  const body = hasPrompt
    ? {
        gpt_description_prompt: args.prompt,
        mv: model,
        make_instrumental: Boolean(args.instrumental),
      }
    : {
        prompt: args.lyrics,
        tags: args.tags,
        mv: model,
        make_instrumental: Boolean(args.instrumental),
      };
  if (args.title !== undefined) body.title = args.title;
  return runSubmitFlow(ctx, args, (client) => client.generateMusic(body));
}

async function sound(ctx, args) {
  const title = requireOption(args.text, "--text");
  const body = { title, tags: args.tags, loop: Boolean(args.loop) };
  if (args.model !== undefined) {
    if (!SOUND_MODELS.includes(args.model)) {
      throw cliError("E_INVALID_OPTION", `--model 仅支持 ${SOUND_MODELS.join("|")}`, {
        option: "--model",
        value: args.model,
      });
    }
    body.mv = args.model;
  }
  return runSubmitFlow(ctx, args, (client) => client.generateSound(body));
}

async function task(_ctx, args) {
  const id = requireOption(args.id, "--id");
  const client = createSunoClient(getConfig());
  const t = await client.getTask(id);
  if (t.status !== "completed") return { taskId: id, status: t.status };
  return {
    taskId: id,
    status: t.status,
    title: t.title,
    durationSec: t.durationSec,
    audioUrl: t.audioUrl,
    coverUrl: t.coverUrl,
    customId: t.customId,
  };
}

async function download(ctx, args) {
  const id = requireOption(args.id, "--id");
  const output = requireOption(args.output, "--output");
  const client = createSunoClient(getConfig());
  const t = await client.getTask(id);
  if (t.status !== "completed") {
    throw cliError("E_PROVIDER_ERROR", `任务未完成，状态：${t.status}`, { status: t.status });
  }
  if (!t.audioUrl) {
    throw cliError("E_PROVIDER_ERROR", "任务缺少音频地址", { reason: "no_audio_url" });
  }
  const file = await downloadFile(t.audioUrl, path.resolve(ctx.cwd, output));
  return { path: file.path, bytes: file.bytes, durationSec: t.durationSec };
}

async function balance(_ctx, _args) {
  const client = createSunoClient(getConfig());
  return { remainingPoints: await client.getBalance() };
}

export default { gen, sound, task, download, balance };
