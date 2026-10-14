// 重试账本的**唯一口径**（Bug 1 + Bug 2）。
// client.mjs 的 E_PROVIDER_ERROR 消息与 progress.mjs 汇总的 E_PROVIDER_RETRY warning 都从这里取数，
// 所以同一个 run 里不可能再出现「退避重试 8 次」与「已重试 9 次」两个互相矛盾的数字（Bug 2），
// 也不可能把没执行的那一步算进累计等待（Bug 1）。
// 输出仍只有两条既有出口（stderr warn 与 envelope warnings[]），这里不碰任何流（AGENTS.md §4.1）。
//
// 一行账本 = 一次「被 provider 拒掉 / 暂时查不到」的请求。三个数都只认账本行：
//   rejected  = 账本行数 = 提交出去但没被放行的请求次数（**含首次提交**）
//   retries   = 一次被拒之后**真的又发了一次请求**的次数 = 首次提交之外的补发次数
//   waitedMs  = 真正睡下去的毫秒总和
// retries 与 waitedMs 同源：只有 `waited === true` 的那几行才既算一次重试、又把自己的时长计进等待。
// 收尾那次被拒（预算用尽 / 越过 deadline / 超时抛错）后面没有再发请求、也没睡，
// 所以它两头都不计——这正是 stampWait 存在的理由。

/**
 * 把「这一步到底等不等」在记账**之前**定死，产出一行账本。
 * `wait` 来自 backoff.mjs 的 retryWaitMs（waitMs + waitSource）加上调用方的 willWait 判定；
 * 调用方必须在 push/record 之后立刻按 willWait 决定 return 还是 sleep，二者共用同一个布尔，
 * 这样账本与真实行为不可能分叉。
 */
export function stampWait(attempt, wait) {
  return {
    ...attempt,
    // 计划/被明示的等待时长（保留原字段语义，便于对照 provider 的 Retry-After 与我们的阶梯）
    retryAfterMs: wait.waitMs,
    waitSource: wait.waitSource,
    // 真正执行了这一步等待才计（Bug 1）
    waited: wait.willWait,
    waitedMs: wait.willWait ? wait.waitMs : 0,
  };
}

/** 从账本行算出唯一的三个数 + 按 kind 的分桶摘要 */
export function retryTally(items) {
  let retries = 0;
  let waitedMs = 0;
  const byKind = {};
  for (const item of items) {
    if (item.waited === true) retries += 1;
    waitedMs += item.waitedMs ?? 0;
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  }
  const parts = Object.entries(byKind)
    .map(([kind, count]) => `${kind}×${count}`)
    .join(", ");
  // 没有一行标了 waited（调用方给的旧形态账本）时宁缺毋滥：绝不把整份 retryAfterMs 当等待
  return { rejected: items.length, retries, waitedMs, parts };
}

/**
 * 两个报告方共用的句子。措辞把「提交次数」与「重试次数」分别点名（Bug 2 要求语义可读）：
 * `退避重试 N 次` 只数首次提交之后的补发，`未放行请求 M 次` 才是提交总数（含首次）。
 */
export function retryTallyPhrase(tally) {
  return (
    `已原地退避重试 ${tally.retries} 次` +
    `（未放行请求 ${tally.rejected} 次，含首次提交；${tally.parts}；` +
    `实际累计等待 ${tally.waitedMs}ms，只计真睡过的那几步）`
  );
}
