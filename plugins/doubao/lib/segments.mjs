// 静音检测：ffmpeg silencedetect 只写 stderr，这里解析成 {start,end} 区间供分段候选
export function parseSilences(stderr) {
  const silences = [];
  let pending = null;
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) {
      pending = Math.max(0, Number.parseFloat(start[1]));
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end && pending !== null) {
      const t = Math.max(0, Number.parseFloat(end[1]));
      silences.push({ start: pending, end: Math.max(pending, t) });
      pending = null;
    }
  }
  return silences;
}

// 按目标时长贪心切分，优先落在静音中点（避免切在词中间）；maxSec 是硬上限
export function planSegments({ durationSec, silences = [], targetSec = 30, maxSec = 45 }) {
  if (!(durationSec > 0)) return [];
  if (durationSec <= maxSec) return [{ start: 0, end: durationSec }];

  const midpoints = silences
    .map((s) => (s.start + s.end) / 2)
    .filter((t) => Number.isFinite(t) && t > 0 && t < durationSec)
    .sort((a, b) => a - b);

  const cuts = [];
  let start = 0;
  while (durationSec - start > maxSec) {
    // 太短的段没意义：候选切点至少要离段首 targetSec 的 4 成（或 5s）
    const lo = start + Math.min(targetSec * 0.4, 5);
    const hi = Math.min(start + maxSec, durationSec);
    const ideal = Math.min(start + targetSec, hi);
    let best = null;
    for (const m of midpoints) {
      if (m <= lo || m > hi) continue;
      if (best === null || Math.abs(m - ideal) < Math.abs(best - ideal)) best = m;
    }
    const end = best ?? hi;
    // 尾巴不足 2s 就别切了：让上一段直接延到结尾，避免产生无意义碎段
    if (durationSec - end < 2) break;
    cuts.push(end);
    start = end;
  }

  const bounds = [0, ...cuts, durationSec];
  const segments = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (to - from > 0.05) segments.push({ start: from, end: to });
  }
  return segments;
}
