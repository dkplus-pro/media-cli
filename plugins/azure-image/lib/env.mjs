import { cliError } from "./errors.mjs";

const OUTPUT_FORMATS = ["png", "jpeg", "webp"];
const QUALITIES = ["auto", "low", "medium", "high"];

function parsePool(raw, name) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw cliError("E_CONFIG", `缺少环境变量 ${name}`, { var: name });
  }
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw cliError("E_CONFIG", `环境变量 ${name} 解析结果为空`, { var: name });
  }
  return items;
}

// KEY_POOL[i] ↔ ENDPOINT_POOL[i] 按索引一一对应（D4）；同一 URL 配不同 key 是合法配对，不去重
export function loadConfig(env = process.env) {
  const keys = parsePool(env.AZURE_IMAGE_KEY_POOL, "AZURE_IMAGE_KEY_POOL");
  const endpoints = parsePool(env.AZURE_IMAGE_ENDPOINT_POOL, "AZURE_IMAGE_ENDPOINT_POOL");
  if (keys.length !== endpoints.length) {
    throw cliError(
      "E_CONFIG",
      "AZURE_IMAGE_KEY_POOL 与 AZURE_IMAGE_ENDPOINT_POOL 数量不一致，必须按索引一一配对",
      { keyCount: keys.length, endpointCount: endpoints.length },
    );
  }
  const accounts = endpoints.map((endpoint, index) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw cliError("E_CONFIG", `AZURE_IMAGE_ENDPOINT_POOL[${index}] 不是合法 URL`, {
        index,
        endpoint,
      });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw cliError("E_CONFIG", `AZURE_IMAGE_ENDPOINT_POOL[${index}] 协议必须是 http/https`, {
        index,
      });
    }
    return { endpoint: endpoint.replace(/\/+$/, ""), key: keys[index] };
  });

  const outputFormat = env.AZURE_IMAGE_OUTPUT_FORMAT ?? "png";
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    throw cliError("E_CONFIG", `AZURE_IMAGE_OUTPUT_FORMAT 仅支持 ${OUTPUT_FORMATS.join("|")}`, {
      var: "AZURE_IMAGE_OUTPUT_FORMAT",
      value: outputFormat,
    });
  }
  const quality = env.AZURE_IMAGE_QUALITY ?? "auto";
  if (!QUALITIES.includes(quality)) {
    throw cliError("E_CONFIG", `AZURE_IMAGE_QUALITY 仅支持 ${QUALITIES.join("|")}`, {
      var: "AZURE_IMAGE_QUALITY",
      value: quality,
    });
  }

  return {
    accounts,
    deployment: env.AZURE_IMAGE_DEPLOYMENT ?? "gpt-image-2",
    outputFormat,
    quality,
    apiVersion: env.AZURE_IMAGE_API_VERSION ?? "2025-04-01-preview",
  };
}
