// 背景/分隔带取色的候选集（F2）。
// 老算法只取「四边 8px 条带的中位数」当背景色，遇到**满幅宫格**（内容顶到图片边缘、只靠格间
// 细缝分隔）时，四边条带本身就是内容 → 取到的背景色是某个内容色 → 每一块都被当成背景 →
// 返回 single_band 拒绝检出。放大 --flat-tol 也救不了：错的是**选色**，不是容差。
//
// 这里的思路：分隔带的颜色未必等于边框颜色，但**它一定会构成笔直的整行/整列**。
// 所以先给出一小撮候选色（四边中位数、四边众数、全图高频色），再由调用方按
// 「该色构成的直线数」打分挑一个最像分隔带的来用 —— 见 grid-detect.mjs。

const GREY_LEVELS = 256;

function isEdgePixel(edgeRow, x, width, band) {
  return edgeRow || x < band || x >= width - band;
}

// 四边各 band 像素的灰度直方图（一次遍历顺手把全图直方图也攒出来，避免为候选色反复扫大图）
function bandHistograms(data, width, height, edgeBandWidth) {
  const band = Math.max(1, Math.min(edgeBandWidth, Math.min(width, height)));
  const edge = new Uint32Array(GREY_LEVELS);
  const all = new Uint32Array(GREY_LEVELS);
  let edgeTotal = 0;
  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < band || y >= height - band;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const v = data[row + x];
      all[v] += 1;
      if (isEdgePixel(edgeRow, x, width, band)) {
        edge[v] += 1;
        edgeTotal += 1;
      }
    }
  }
  return { edge, all, edgeTotal };
}

function medianFromCounts(counts, total) {
  if (total === 0) return null;
  const half = total / 2;
  let seen = 0;
  for (let v = 0; v < GREY_LEVELS; v += 1) {
    seen += counts[v];
    if (seen >= half) return v;
  }
  return null;
}

function modeFromCounts(counts) {
  let best = null;
  let bestCount = 0;
  for (let v = 0; v < GREY_LEVELS; v += 1) {
    if (counts[v] > bestCount) {
      best = v;
      bestCount = counts[v];
    }
  }
  return bestCount > 0 ? best : null;
}

// 按出现次数从高到低取前 limit 个灰度值
function topValues(counts, limit) {
  const pairs = [];
  for (let v = 0; v < GREY_LEVELS; v += 1) if (counts[v] > 0) pairs.push([v, counts[v]]);
  pairs.sort((a, b) => b[1] - a[1]);
  return pairs.slice(0, limit).map((pair) => pair[0]);
}

// §6.2 第 1 步的老口径：四边条带的中位数灰度（宫格底通常是纯白或纯黑）。
// 满幅宫格下它取到的会是内容色，所以它只是**候选之一**，最终由「谁构成的直线多」定夺。
export function estimateBackground(data, width, height, edgeBand = 8) {
  const { edge, edgeTotal } = bandHistograms(data, width, height, edgeBand);
  return medianFromCounts(edge, edgeTotal);
}

export function backgroundCandidates(data, width, height, { edgeBand = 8, limit = 8 } = {}) {
  const { edge, all, edgeTotal } = bandHistograms(data, width, height, edgeBand);
  const out = [];
  const add = (value) => {
    if (Number.isInteger(value) && value >= 0 && value < GREY_LEVELS && !out.includes(value)) {
      out.push(value);
    }
  };
  // 顺序只在「打分并列」时起决定作用：仍以老行为的四边中位数优先
  add(medianFromCounts(edge, edgeTotal));
  add(modeFromCounts(edge));
  for (const value of topValues(all, limit)) add(value);
  return out;
}
