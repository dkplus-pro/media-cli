import { cliError } from "./errors.mjs";

// 401/403/429/5xx/网络错误轮换下一账号（D4）；400 类参数错误换账号无意义，不轮换
const ROTATE_STATUS = new Set([401, 403, 429]);

function scrub(text, keys) {
  let out = text;
  for (const key of keys) {
    if (key && key.length >= 8) out = out.split(key).join("***");
  }
  return out;
}

function buildUrl(account, config, hasRefs) {
  const deployment = encodeURIComponent(config.deployment);
  const apiVersion = encodeURIComponent(config.apiVersion);
  const action = hasRefs ? "images/edits" : "images/generations";
  return `${account.endpoint}/openai/deployments/${deployment}/${action}?api-version=${apiVersion}`;
}

function buildRequest(config, { prompt, size, quality, refs }) {
  if (refs.length > 0) {
    const form = new FormData();
    for (const ref of refs) {
      form.append("image[]", new Blob([ref.data], { type: ref.mime }), ref.name);
    }
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    form.append("output_format", config.outputFormat);
    // content-type 由 fetch 自动生成（含 boundary），不得手工设置
    return { method: "POST", body: form };
  }
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt,
      size,
      quality,
      output_format: config.outputFormat,
      n: 1,
    }),
  };
}

export async function generateImage(config, { prompt, size, quality, refs }) {
  const keys = config.accounts.map((a) => a.key);
  const total = config.accounts.length;
  const start = Math.floor(Math.random() * total);
  const attempts = [];

  for (let i = 0; i < total; i++) {
    const index = (start + i) % total;
    const account = config.accounts[index];
    const url = buildUrl(account, config, refs.length > 0);
    const init = buildRequest(config, { prompt, size, quality, refs });

    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${account.key}` },
      });
    } catch (err) {
      attempts.push({ index, message: scrub(String(err?.message ?? err), keys) });
      continue;
    }

    if (res.ok) {
      let item;
      try {
        item = (await res.json())?.data?.[0];
      } catch {
        item = undefined;
      }
      if (typeof item?.b64_json !== "string" || item.b64_json === "") {
        // 2xx 但内容为空不是账号问题，不轮换
        attempts.push({ index, status: res.status, message: "empty b64_json" });
        throw cliError("E_PROVIDER_ERROR", "azure image 响应缺少 b64_json", { attempts });
      }
      return {
        b64: item.b64_json,
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        account: { index, endpoint: account.endpoint },
      };
    }

    const bodyText = await res.text().catch(() => "");
    attempts.push({ index, status: res.status, message: scrub(bodyText.slice(0, 200), keys) });
    if (!ROTATE_STATUS.has(res.status) && res.status < 500) {
      throw cliError("E_PROVIDER_ERROR", `azure image 请求失败（HTTP ${res.status}）`, {
        attempts,
      });
    }
  }

  throw cliError("E_PROVIDER_ERROR", "azure image 全部账号均失败", { attempts });
}
