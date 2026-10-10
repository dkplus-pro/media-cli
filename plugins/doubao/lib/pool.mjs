// 有界并发 map：结果按原索引归位，任一任务失败即整体 reject（保留首个错误）
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(runners);
  return results;
}
