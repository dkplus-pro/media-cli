import { run, WHISPER_TIMEOUT_MS } from "./proc.mjs";

export async function transcribeToSrt({
  whisperBin,
  modelPath,
  wavPath,
  outPrefix,
  language,
  timeoutMs = WHISPER_TIMEOUT_MS,
}) {
  const args = ["-m", modelPath, "-f", wavPath, "-osrt", "-of", outPrefix];
  if (language && language !== "auto") args.push("-l", language);
  await run(whisperBin, args, { source: "whisper", timeoutMs });
  return `${outPrefix}.srt`;
}

// SRT 分段数 = 最大序号
export function countSegments(srtText) {
  const indexes = srtText.match(/^\d+\s*$/gm) ?? [];
  return indexes.reduce((max, line) => Math.max(max, Number.parseInt(line, 10) || 0), 0);
}
