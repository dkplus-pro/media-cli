// 放大回原图后的重叠清理（F2）—— 产出侧（doubao-grid-locate）的修复步骤。
//
// 为什么必须在**产出侧**做：模型看到的是 --max-side 降采样后的那张图，坐标天然是小图里的整数；
// upscaleCellsToOriginal() 再 round 一次，相邻两格的公共边就会错开 ±1 像素 —— 放大到原图空间
// 就是一层几像素厚的「薄条重叠」。这是这条链的固有产物，不是模型的错，也不是用户的错。
// 旧行为：产出侧留着它，消费侧 media-grid-caption 用自己的严格 §2 校验把兄弟命令的产物直接
// E_INVALID_OPTION 拒掉（实测：真实页 S019 两格重叠 628x24px 时整条流水线断在中间）。
// 现在：**能就地修干净的就地修**（只在重叠区里切，绝不改动重叠区以外的几何），
// 修了多少记进 data.overlapRepaired 并附警告；修不动的大重叠照样留在产物里，由消费侧判并点名。
//
// 阈值 5% 的来历（全部实测，2048x2048 真实分镜页）：
//   · 纯取整误差：±1 小图像素 ÷ sx=0.765625 → 最多 1.3 原图像素；300px 高的格 = 0.43%
//   · 真实放大后的最坏重叠：628x24px，厚度占较小格对应边 24/680 ≈ 3.5%
//   · 模型真的把两格框重了的实测重叠：112x550 / 100x300，厚度 33% 以上 → 不在修复范围
// 所以「薄边 ≤ 5% 认为是放大取整产物」既放得过实测最坏值，又拦得住真误检。

const MAX_ROUNDS = 64;
// 单格最多被切掉自身面积的 25%：超过就说明模型给的是两个真重叠的框，削齐它会静默改走版图，
// 那不如原样交给消费侧报错让人工看
const MAX_REMOVED_AREA_FRACTION = 0.25;

// 面积重叠（只共边/共点不算：规则宫格天然贴边）
export function cellOverlapOf(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

// 重叠里相对更「薄」的那一轴 —— 薄条重叠就是「两格几乎并排、公共边错了几像素」的形状
function thinAxis(a, b, box) {
  const smaller = a.w * a.h <= b.w * b.h ? a : b;
  const byW = box.w / smaller.w;
  const byH = box.h / smaller.h;
  return { axis: byW <= byH ? "x" : "y", thinness: Math.min(byW, byH) };
}

// 只切「较大的一格」：较小格多半是模型刚好看漏的那一格，保住它的完整矩形更贴近真相。
// 切掉的是重叠区本身（往内收 overlap 那么厚的一条），不触碰重叠区以外的像素；
// 从哪一侧收取决于两格中心的相对位置。返回 null 表示这一刀不可接受（切穿了或削掉太多）。
function trim(cell, other, box, axis) {
  const out = { ...cell };
  if (axis === "x") {
    if (cell.x + cell.w / 2 >= other.x + other.w / 2) {
      out.x += box.w;
      out.w -= box.w;
    } else {
      out.w -= box.w;
    }
  } else {
    if (cell.y + cell.h / 2 >= other.y + other.h / 2) {
      out.y += box.h;
      out.h -= box.h;
    } else {
      out.h -= box.h;
    }
  }
  if (out.w < 1 || out.h < 1) return null;
  const areaBefore = cell.w * cell.h;
  if (areaBefore - out.w * out.h > areaBefore * MAX_REMOVED_AREA_FRACTION) return null;
  return out;
}

/**
 * 把放大后产生的「薄条重叠」就地修成互不重叠的一组格子（纯函数，不改入参）。
 * @param {{ limit?: number }} options 薄边阈值（重叠厚度 ÷ 较小格对应边长）
 * @returns {{ cells: object[], repaired: number, remaining: number, limit: number }}
 *          repaired = 被切过的格子数；remaining = 修完仍剩下的重叠对数（交给消费侧）
 */
export function repairCellOverlaps(cells, { limit = 0.05 } = {}) {
  const boxes = cells.map((cell) => ({ ...cell }));
  let repaired = 0;
  // limit ≤ 0 时不修任何一格（下面 `thinness > limit` 恒成立），但 remaining 照样要数清楚
  for (let round = 0; boxes.length > 1 && round < MAX_ROUNDS; round += 1) {
    let hit = null;
    for (let i = 0; i < boxes.length && hit === null; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const box = cellOverlapOf(boxes[i], boxes[j]);
        if (box === null) continue;
        const { axis, thinness } = thinAxis(boxes[i], boxes[j], box);
        if (thinness > limit) continue;
        const targetIndex = boxes[i].w * boxes[i].h >= boxes[j].w * boxes[j].h ? i : j;
        const otherIndex = targetIndex === i ? j : i;
        const next = trim(boxes[targetIndex], boxes[otherIndex], box, axis);
        if (next === null) continue;
        hit = { targetIndex, next };
        break;
      }
    }
    if (hit === null) break;
    boxes[hit.targetIndex] = { ...boxes[hit.targetIndex], ...hit.next };
    repaired += 1;
  }
  let remaining = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (cellOverlapOf(boxes[i], boxes[j]) !== null) remaining += 1;
    }
  }
  return { cells: boxes, repaired, remaining, limit };
}
