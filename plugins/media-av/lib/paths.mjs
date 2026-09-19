import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { cliError } from "./errors.mjs";

function findOnPath(name, env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // 继续找下一个目录
    }
  }
  return null;
}

function resolveBinary({ envVar, names, dependency, hint }, env = process.env) {
  const override = env[envVar];
  if (override) {
    try {
      accessSync(override, constants.X_OK);
      return override;
    } catch {
      throw cliError("E_MISSING_DEPENDENCY", `${dependency} 不可执行：${override}`, {
        dependency,
        envVar,
        value: override,
        hint,
      });
    }
  }
  for (const name of names) {
    const found = findOnPath(name, env);
    if (found) return found;
  }
  throw cliError("E_MISSING_DEPENDENCY", `找不到 ${dependency}（${names.join(" / ")}）`, {
    dependency,
    hint,
  });
}

export function resolveFfmpeg(env = process.env) {
  return resolveBinary(
    {
      envVar: "FFMPEG_PATH",
      names: ["ffmpeg"],
      dependency: "ffmpeg",
      hint: "brew install ffmpeg 或设置 FFMPEG_PATH",
    },
    env,
  );
}

export function resolveFfprobe(env = process.env) {
  return resolveBinary(
    {
      envVar: "FFPROBE_PATH",
      names: ["ffprobe"],
      dependency: "ffprobe",
      hint: "brew install ffmpeg 或设置 FFPROBE_PATH",
    },
    env,
  );
}

// 注意：不匹配裸名 whisper（python 版 openai-whisper，参数不兼容）
export function resolveWhisper(env = process.env) {
  return resolveBinary(
    {
      envVar: "WHISPER_CPP_BIN",
      names: ["whisper-cli", "whisper-cpp"],
      dependency: "whisper.cpp",
      hint: "brew install whisper-cpp 或设置 WHISPER_CPP_BIN",
    },
    env,
  );
}

export function resolveWhisperModel({ option, env = process.env }) {
  const modelPath = option ?? env.WHISPER_MODEL;
  if (!modelPath) {
    throw cliError("E_CONFIG", "缺少 whisper ggml 模型", {
      var: "WHISPER_MODEL",
      hint: "下载 ggml 模型（base/small/medium）并设置 WHISPER_MODEL，或用 --model-path 指定",
    });
  }
  try {
    statSync(modelPath);
  } catch {
    throw cliError("E_CONFIG", `whisper 模型不存在：${modelPath}`, {
      var: "WHISPER_MODEL",
      value: modelPath,
      hint: "下载 ggml 模型（base/small/medium）并设置 WHISPER_MODEL，或用 --model-path 指定",
    });
  }
  return modelPath;
}
