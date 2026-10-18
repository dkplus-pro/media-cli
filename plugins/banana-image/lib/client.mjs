import { cliError } from "./errors.mjs";

function scrub(text, key) {
  return key && key.length >= 8 ? String(text).split(key).join("***") : String(text);
}

function errorMessage(text) {
  try {
    const payload = JSON.parse(text);
    const fromError = payload?.error;
    if (typeof fromError === "string" && fromError !== "") return fromError;
    if (typeof fromError?.message === "string" && fromError.message !== "") {
      return fromError.message;
    }
    if (typeof payload?.message === "string" && payload.message !== "") return payload.message;
  } catch {
    // 非 JSON 响应体，保留原文
  }
  return String(text ?? "").slice(0, 300);
}

function requestInit(config, { prompt, size, quality, refs }) {
  if (refs.length > 0) {
    const form = new FormData();
    for (const ref of refs) {
      form.append("image[]", new Blob([ref.data], { type: ref.mime }), ref.name);
    }
    form.append("model", config.model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    form.append("output_format", config.outputFormat);
    form.append("response_format", "b64_json");
    // content-type 由 fetch 自动生成（含 boundary），不得手工设置
    return { method: "POST", body: form };
  }
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      prompt,
      size,
      quality,
      output_format: config.outputFormat,
      response_format: "b64_json",
      n: 1,
    }),
  };
}

async function fetchImage(config, url) {
  let res;
  try {
    // 结果 URL 是对象存储直链：不携带 Authorization，避免把 key 发给第三方
    res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `banana 图片下载失败：${String(err?.message ?? err)}`, {
      source: "banana-image",
      reason: err?.name === "TimeoutError" ? "timeout" : "network_error",
      url,
    });
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `banana 图片下载失败（HTTP ${res.status}）`, {
      source: "banana-image",
      status: res.status,
      url,
    });
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function generateImage(config, options) {
  const action = options.refs.length > 0 ? "edits" : "generations";
  const url = `${config.baseUrl}/v1/images/${action}`;
  let res;
  try {
    res = await fetch(url, {
      ...requestInit(config, options),
      headers: {
        ...(options.refs.length > 0 ? {} : requestInit(config, options).headers),
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw cliError(
      "E_PROVIDER_ERROR",
      timeout
        ? `banana 请求超时（${config.timeoutMs}ms）`
        : `banana 网络请求失败：${String(err?.message ?? err)}`,
      { source: "banana-image", reason: timeout ? "timeout" : "network_error" },
    );
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const message = scrub(errorMessage(text), config.apiKey);
    if (res.status === 401 || res.status === 403) {
      throw cliError("E_CONFIG", `BANANA_IMAGE_API_KEY 无效或无权限（HTTP ${res.status}）`, {
        var: "BANANA_IMAGE_API_KEY",
        status: res.status,
        providerMessage: message,
      });
    }
    throw cliError(
      "E_PROVIDER_ERROR",
      `banana 请求失败（HTTP ${res.status}）${message === "" ? "" : `：${message}`}`,
      {
        source: "banana-image",
        status: res.status,
        ...(res.status === 429 ? { reason: "rate_limited" } : {}),
        providerMessage: message,
      },
    );
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw cliError("E_PROVIDER_ERROR", "banana 响应不是合法 JSON", {
      source: "banana-image",
      body: scrub(text.slice(0, 300), config.apiKey),
    });
  }
  const item = payload?.data?.[0];
  if (typeof item?.b64_json === "string" && item.b64_json !== "") {
    return {
      buf: Buffer.from(item.b64_json, "base64"),
      revisedPrompt:
        typeof item.revised_prompt === "string" && item.revised_prompt !== ""
          ? item.revised_prompt
          : undefined,
      usage: payload?.usage,
    };
  }
  if (typeof item?.url === "string" && item.url !== "") {
    return {
      buf: await fetchImage(config, item.url),
      sourceUrl: item.url,
      revisedPrompt:
        typeof item.revised_prompt === "string" && item.revised_prompt !== ""
          ? item.revised_prompt
          : undefined,
      usage: payload?.usage,
    };
  }
  throw cliError("E_PROVIDER_ERROR", "banana 响应缺少 b64_json/url", {
    source: "banana-image",
    body: scrub(text.slice(0, 300), config.apiKey),
  });
}
