// 插件内统一抛错工厂：鸭子类型携带已登记错误码（D7），壳负责识别与退出码映射
export function cliError(code, message, details) {
  return Object.assign(new Error(message), {
    code,
    ...(details === undefined ? {} : { details }),
  });
}

const DEFAULT_BASE_URL = "https://open.suno.cn";

// env 读取必须在 handler 内进行（index.mjs 顶层零副作用），否则缺 key 会让所有命令崩溃
export function getConfig(env = process.env) {
  const apiKey = env.SUNO_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw cliError("E_CONFIG", "缺少 SUNO_API_KEY（在 open.suno.cn 商户后台创建）", {
      var: "SUNO_API_KEY",
    });
  }
  return {
    apiKey,
    baseUrl: (env.SUNO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    pollIntervalMs: Number.parseInt(env.SUNO_POLL_INTERVAL_MS ?? "", 10) || 5000,
    timeoutMs: Number.parseInt(env.SUNO_TIMEOUT_MS ?? "", 10) || 600000,
  };
}
