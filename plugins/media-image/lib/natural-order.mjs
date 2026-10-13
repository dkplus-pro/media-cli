import path from "node:path";

const CHUNK_RE = /\d+|\D+/g;
const DIGIT_ONLY_RE = /^\d+$/;

function chunksOf(name) {
  return name.toLowerCase().match(CHUNK_RE) ?? [];
}

// 数值段按大小比较；等值时前导零更多者排后，保证排序结果确定
function compareNumericChunk(a, b) {
  const sa = a.replace(/^0+/, "") || "0";
  const sb = b.replace(/^0+/, "") || "0";
  if (sa.length !== sb.length) return sa.length > sb.length ? 1 : -1;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
}

// 自然序：page2.jpg 排在 page10.jpg 之前，其余按不区分大小写字典序
export function naturalCompare(a, b) {
  const xs = chunksOf(a);
  const ys = chunksOf(b);
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === y) continue;
    if (DIGIT_ONLY_RE.test(x) && DIGIT_ONLY_RE.test(y)) return compareNumericChunk(x, y);
    return x < y ? -1 : 1;
  }
  return xs.length === ys.length ? 0 : xs.length > ys.length ? 1 : -1;
}

// 逐路径段比较：先目录后文件名，避免整体字符串比较把子目录顺序打乱
function compareSegments(a, b) {
  const xs = a.relative.split(path.sep);
  const ys = b.relative.split(path.sep);
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    const r = naturalCompare(xs[i], ys[i]);
    if (r !== 0) return r;
  }
  return xs.length === ys.length ? 0 : xs.length > ys.length ? 1 : -1;
}

export function sortInputs(inputs, order) {
  const sorted = [...inputs];
  if (order === "lexicographic") {
    sorted.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return sorted;
  }
  sorted.sort((a, b) => compareSegments(a, b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted;
}
