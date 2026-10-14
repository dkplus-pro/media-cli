import { cliError } from "./errors.mjs";

export const POOL_NAMES = ["prod", "test"];

// 未显式指定时的内置默认池（prod）；--env 与 COS_ENV 均可覆盖
export const DEFAULT_POOL = "prod";

function requireVar(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw cliError("E_CONFIG", `缺少环境变量 ${name}`, { var: name });
  }
  return value.trim();
}

// CDN_PURGE_URL_<ENV> 是文件生命周期接口地址，这里只借它的 origin 作公网访问域名
function publicBase(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw cliError("E_CONFIG", `${name} 不是合法 URL`, { var: name, value: raw });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("E_CONFIG", `${name} 协议必须是 http/https`, { var: name });
  }
  return url.origin;
}

// 对象 key 前缀：可选，允许空（根目录），不允许以 / 开头，内部重复斜杠折叠且末尾归一
function prefixOf(env, name) {
  const raw = env[name] ?? "";
  if (raw.startsWith("/")) {
    throw cliError("E_CONFIG", `${name} 不能以 / 开头`, { var: name, value: raw });
  }
  const trimmed = raw.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

function positiveInt(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const num = Number.parseInt(value, 10);
  if (!Number.isInteger(num) || num <= 0) {
    throw cliError("E_CONFIG", `${name} 必须是正整数毫秒`, { var: name, value });
  }
  return num;
}

// 池选择：--env 优先，其次 COS_ENV；都未设置（或为空）时落默认池 prod
export function loadPool(explicitEnv, env = process.env) {
  const declared = explicitEnv ?? env.COS_ENV?.trim() ?? "";
  const name = declared === "" ? DEFAULT_POOL : declared;
  if (!POOL_NAMES.includes(name)) {
    throw cliError(
      "E_CONFIG",
      `无效的存储环境池：${declared}（可用 ${POOL_NAMES.join(" | ")}，默认 ${DEFAULT_POOL}）`,
      { var: "COS_ENV", value: declared },
    );
  }
  const tag = name.toUpperCase();
  return {
    name,
    secretId: requireVar(env, "TENCENT_SECRET_ID"),
    secretKey: requireVar(env, "TENCENT_SECRET_KEY"),
    region: requireVar(env, "COS_REGION"),
    bucket: requireVar(env, `COS_${tag}_BUCKET`),
    prefix: prefixOf(env, `COS_${tag}_PREFIX`),
    publicBase: publicBase(requireVar(env, `CDN_PURGE_URL_${tag}`), `CDN_PURGE_URL_${tag}`),
    // 仅自测/代理场景使用：把 SDK 请求指向自建 host（如本地 mock）
    domain: env.TENCENT_COS_DOMAIN?.trim() || undefined,
    timeoutMs: positiveInt(env.TENCENT_COS_TIMEOUT_MS, "TENCENT_COS_TIMEOUT_MS", 120000),
  };
}
