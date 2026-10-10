export function splitLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

export function formatSrtTime(sec) {
  const clamped = Math.max(0, sec);
  const ms = Math.round((clamped % 1) * 1000);
  const total = Math.floor(clamped);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s},${String(Math.min(999, ms)).padStart(3, "0")}`;
}

// 模型不返回时间戳：段边界来自 silencedetect（精确），段内各行按字数比例摊（近似）
export function buildSrt(items) {
  const blocks = [];
  let index = 1;
  for (const item of items) {
    const lines = splitLines(item.text);
    if (lines.length === 0) continue;
    const weights = lines.map((line) => Math.max(1, [...line].length));
    const total = weights.reduce((a, b) => a + b, 0);
    const span = Math.max(0, item.end - item.start);
    let cursor = item.start;
    for (let i = 0; i < lines.length; i += 1) {
      const dur = (weights[i] / total) * span;
      const end = i === lines.length - 1 ? item.end : cursor + dur;
      blocks.push(`${index}\n${formatSrtTime(cursor)} --> ${formatSrtTime(end)}\n${lines[i]}\n`);
      index += 1;
      cursor = end;
    }
  }
  if (blocks.length === 0) return "";
  return `${blocks.join("\n")}\n`;
}

export function joinText(items) {
  return items.flatMap((item) => splitLines(item.text)).join("\n");
}

export function countCues(srt) {
  const indexes = srt.match(/^\d+\s*$/gm) ?? [];
  return indexes.reduce((max, line) => Math.max(max, Number.parseInt(line, 10) || 0), 0);
}
