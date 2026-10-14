// 格子几何的交叉检查（§2 五条规则之外附加的一道关，F3/F2）。
// 单独成文件：cells-io.mjs 负责「读入 + §2 校验」，这里只回答「这些格子放在一起合不合理」。
import { cliError } from "./errors.mjs";

// 重叠分级的默认阈值：**重叠面积 ÷ 较小格面积 ≤ 2% 只警告，> 2% 才是硬错误**。
// 为什么不能「有重叠就拒」（旧行为）：视觉模型的坐标来自 --max-side 降采样后的小图，放大回原图时
// 必然 round 一次，相邻两格的公共边就会错开 ±1 像素 —— 这类薄条重叠是这条链的固有产物，
// 不是用户的输入错误。实测（2048x2048 真实分镜页）：
//   · 纯取整误差：±1 小图像素 ÷ sx=0.765625 → 最多 1.3 原图像素；对 680x660 的格 = 面积占比 ≈0.2%
//   · 真正的误检（同一格被画两条字幕，实测坏例）：100x300 / 90000 ≈ 33%、112x512 / 262144 ≈ 22%
//   · 介于两者之间的「薄但宽」条状重叠（实测最坏 628x24px ≈ 3.3%）已由 doubao-grid-locate
//     在产出侧切齐（data.overlapRepaired），走到消费侧的应当只剩取整形态 → 2% 够用且保守
// 2% 落在「实测取整上限 0.2%」与「实测误检下限 22%」中间的两个数量级上，两端都有余量。
// 需要更宽/更严用 --max-overlap 调；确认是刻意的分层版式用 --allow-overlap 完全放行。
export const DEFAULT_MAX_OVERLAP = 0.02;
// --max-overlap 的合法区间（0 表示「一点重叠都不放过」，仍然允许，只是全按硬错处理）
export const MAX_OVERLAP_MIN = 0;
export const MAX_OVERLAP_MAX = 1;

export function cellArea(cell) {
  return cell.w * cell.h;
}

// 两格是否有**面积重叠**（只共边/共点不算：规则宫格天然贴边）
export function overlapBox(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

// ratio = 占较小格面积的比重（分级唯一依据）；thickness = 薄边占较小格对应边的比重（只用于文案/排查）
function measure(a, b, box) {
  const smaller = Math.min(cellArea(a), cellArea(b));
  return {
    ratio: smaller > 0 ? Math.round(((box.w * box.h) / smaller) * 10000) / 10000 : 1,
    thickness:
      Math.round(Math.min(box.w / Math.min(a.w, b.w), box.h / Math.min(a.h, b.h)) * 10000) / 10000,
  };
}

/**
 * 找出所有重叠格子对并按 --max-overlap 分级。
 * @returns {{ total: number, shown: object[], pairs: object[], severe: object[], minor: object[] }}
 *          severe = 要硬拒的（占比 > maxOverlap），minor = 只警告的（占比 ≤ maxOverlap）
 */
export function findCellOverlaps(cells, { limit = 6, maxOverlap = DEFAULT_MAX_OVERLAP } = {}) {
  const pairs = [];
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const box = overlapBox(cells[i], cells[j]);
      if (box === null) continue;
      pairs.push({
        cells: [cells[i].index, cells[j].index],
        ...box,
        ...measure(cells[i], cells[j], box),
      });
    }
  }
  const severe = pairs.filter((pair) => pair.ratio > maxOverlap);
  return {
    total: pairs.length,
    shown: pairs.slice(0, limit),
    pairs,
    severe,
    minor: pairs.filter((pair) => pair.ratio <= maxOverlap),
  };
}

function describe(pairs) {
  return pairs
    .map(
      (pair) =>
        `第 ${pair.cells[0]} 格与第 ${pair.cells[1]} 格重叠 ${pair.w}x${pair.h}px` +
        `（占较小格 ${Math.round(pair.ratio * 100)}%）`,
    )
    .join("；");
}

// 有**大幅**重叠且没被显式放行 → 返回要抛的错；否则返回 null（由调用方 throw）。
// 措辞铁律：绝不建议用户「用 doubao-grid-locate 重跑」—— 这份 JSON 往往就是那条命令刚产的，
// 让他重跑同一个命令等于原地打转（实测旧文案就是这么写的）。
export function overlapError(
  cells,
  { option, allowOverlap = false, maxOverlap = DEFAULT_MAX_OVERLAP },
) {
  if (allowOverlap) return null;
  const found = findCellOverlaps(cells, { maxOverlap });
  if (found.severe.length === 0) return null;
  const detail = describe(found.severe);
  return cliError(
    "E_INVALID_OPTION",
    `${option} 里有 ${found.severe.length} 组格子**大幅**重叠（超过 --max-overlap ${maxOverlap}）：` +
      `${detail}${found.severe.length > 3 ? "…" : ""} —— 同一格会被画进多条字幕。三条出路（按推荐顺序）：` +
      `1) 确认是刻意的分层版式 → 加 --allow-overlap 放行；` +
      `2) 直接编辑 ${option} 指向的 JSON，把重叠的两格改成共边；` +
      `3) 版式本来就规整 → 去掉 ${option} 改用 --cols/--rows 人工等分`,
    {
      option,
      reason: "overlapping_cells",
      cells: found.severe[0].cells,
      overlaps: found.shown,
      total: found.total,
      severe: found.severe.length,
      maxOverlap,
    },
  );
}

// 小重叠的唯一「非致命」出口：警告文本（分级与硬拒共用 findCellOverlaps，绝不各判一套）
export function overlapWarningText(option, minor, maxOverlap = DEFAULT_MAX_OVERLAP) {
  return (
    `${option} 里有 ${minor.length} 组格子重叠在阈值内（≤ --max-overlap ${maxOverlap}，占较小格面积）：` +
    `${describe(minor)} —— 仍会照常渲染，但重叠区里可能被两条字幕各画一次。` +
    `彻底不再提示用 --allow-overlap，想更严调小 --max-overlap，想修坐标就直接编辑这个 JSON`
  );
}
