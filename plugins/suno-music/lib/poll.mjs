import { cliError } from "./config.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 多 task 并行轮询至终态；单轮查询失败（网络抖动）记警告后继续，仅在超时/收敛时退出
export async function pollTasks(client, taskIds, { intervalMs, timeoutMs, logger }) {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(taskIds);
  const completed = [];
  const failed = [];

  while (remaining.size > 0) {
    const results = await Promise.all(
      [...remaining].map(async (taskId) => {
        try {
          return { taskId, task: await client.getTask(taskId) };
        } catch (err) {
          logger.warn(`查询任务 ${taskId} 失败：${String(err?.message ?? err)}`);
          return { taskId, task: null };
        }
      }),
    );
    for (const { taskId, task } of results) {
      if (task === null) continue;
      if (task.status === "completed") {
        completed.push({ taskId, task });
        remaining.delete(taskId);
      } else if (task.status === "failed") {
        failed.push({ taskId, reason: "task_failed" });
        remaining.delete(taskId);
      }
    }
    if (remaining.size === 0) break;
    if (Date.now() >= deadline) {
      throw cliError("E_PROVIDER_ERROR", "suno 轮询超时，可稍后用 suno-download 恢复", {
        reason: "timeout",
        taskIds: [...remaining],
      });
    }
    await sleep(intervalMs);
  }

  return { completed, failed };
}
