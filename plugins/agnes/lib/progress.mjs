// 重试进度账本（B4）。两条出口，都不直接碰 process.stdout/stderr（AGENTS.md §4.1：
// 只有 src/core/output 能写流），也不违反 --json 下 stdout 单文档契约（§4.2）：
//   1) 逐次 ctx.logger.warn → stderr：human 模式与 --json --verbose 可见
//   2) 汇总一条 warning → --json envelope 的 warnings[]：纯 --json 的调用方（AI/管道）
//      只有这一条通道——壳的 logger 在 json 模式把 info 与 warn 都屏蔽了（logger.ts:19,22），
//      所以「重试风暴在 stderr 里全空」必须靠 envelope 才能被看见
// 汇总里的三个数（重试次数 / 未放行请求数 / 累计等待）一律经 retry-ledger.mjs 计算：
// 与 client.mjs 的 E_PROVIDER_ERROR 消息同源同措辞，同一个 run 里两处不可能各说各话（Bug 1 + Bug 2）。
import { retryTally, retryTallyPhrase } from "./retry-ledger.mjs";

export function createRetryProgress() {
  const items = [];
  return {
    record(item) {
      items.push(item);
    },
    // 一次命令只产出一条 warning：实测 46 次 503 不该把 envelope 撑爆
    summaryWarning() {
      if (items.length === 0) return undefined;
      const last = items[items.length - 1];
      return {
        code: "E_PROVIDER_RETRY",
        plugin: "agnes",
        message: `provider 侧容量抖动，${retryTallyPhrase(retryTally(items))}；最后一次：${last.message}`,
      };
    },
  };
}

/**
 * 跑一段会重试的命令体，并把账本汇总挂到 ctx.warnings（B4）。
 * 用 finally：命令最终失败时 warning 也要进 envelope——`--json` 的调用方只有把
 * error.details.attempts 与 warnings 一起读，才拼得出「到底重试了多久、为什么放弃」。
 * 仍只经 ctx 的两条既有出口，不碰流、不改 stdout 的单 JSON 文档（AGENTS.md §4）。
 */
export async function withRetryProgress(ctx, run) {
  const progress = createRetryProgress();
  try {
    return await run(progress);
  } finally {
    const warning = progress.summaryWarning();
    if (warning !== undefined) ctx.warnings.add(warning);
  }
}
