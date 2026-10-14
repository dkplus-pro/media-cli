import { downloadBytes, rotateKeys, tryRequestJson } from "./client.mjs";
import { requestIdOf, scrub } from "./error-text.mjs";
import { cliError } from "./errors.mjs";

const IMAGE_PATH = "/v1/images/generations";

/**
 * 请求体字段位置是实测出来的（§3.4），放错就 400：
 * - `response_format` 与 `image` 必须嵌在 `extra_body` 里（放根级会报验证错）
 * - `extra_body.image` 是数组（单张也要数组），且只在有参考图时出现（空数组不要发）
 * - `ratio` 只在 `size` 是档位（1K–4K）时发
 * - 禁止发 `tags:["img2img"]`（文档明确会报错）
 */
export function buildImageBody({ model, prompt, size, ratio, refs, format }) {
  const body = { model, prompt, size };
  if (ratio !== undefined) body.ratio = ratio;
  const extra = { response_format: format };
  if (refs !== undefined && refs.length > 0) extra.image = refs;
  body.extra_body = extra;
  return body;
}

// 实测成功体：{"data":[{"url":"…","b64_json":"","revised_prompt":""}],"created":<unix秒>,"task_id":"task_…"}
// 注意 revised_prompt 实测是空字符串（文档写 null），根级 task_id 文档没提但实测有
function imageOf(json) {
  const found = (json?.data ?? []).find(
    (item) =>
      (typeof item?.url === "string" && item.url !== "") ||
      (typeof item?.b64_json === "string" && item.b64_json !== ""),
  );
  if (found === undefined) return undefined;
  return {
    ...(typeof found.url === "string" && found.url !== "" ? { url: found.url } : {}),
    ...(typeof found.b64_json === "string" && found.b64_json !== "" ? { b64: found.b64_json } : {}),
    ...(typeof found.revised_prompt === "string" && found.revised_prompt !== ""
      ? { revisedPrompt: found.revised_prompt }
      : {}),
  };
}

function taskIdOf(json) {
  return typeof json?.task_id === "string" && json.task_id !== "" ? json.task_id : undefined;
}

/**
 * agnes 生图是**同步**接口（§1.1，不是异步任务），一次 POST 拿到 url 或 b64_json。
 * key 轮换 / 容量（429+503）退避重试都在 rotateKeys 里（D22 已由实测修正，见 client.mjs）。
 */
export async function generateImage(config, options) {
  const body = buildImageBody(options);
  const deadline = options.deadline ?? Date.now() + config.timeoutMs;
  const { json, keyIndex } = await rotateKeys(config, {
    deadline,
    logger: options.logger,
    progress: options.progress,
    send: (key) =>
      tryRequestJson(
        config,
        `${config.baseUrl}${IMAGE_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        key,
      ),
  });

  const found = imageOf(json);
  const requestId = requestIdOf(json);
  const taskId = taskIdOf(json);
  if (found === undefined) {
    throw cliError("E_PROVIDER_ERROR", "agnes 响应中没有图片数据", {
      source: "agnes",
      reason: "no_image",
      keyIndex,
      ...(requestId === undefined ? {} : { requestId }),
      body: scrub(JSON.stringify(json).slice(0, 300), config.keys),
    });
  }
  // --format url 时结果在另一个域，下载不带 Authorization
  const bytes =
    found.b64 === undefined
      ? await downloadBytes(config, found.url, "download")
      : Buffer.from(found.b64, "base64");

  return {
    bytes,
    keyIndex,
    ...(found.url === undefined ? {} : { url: found.url }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(found.revisedPrompt === undefined ? {} : { revisedPrompt: found.revisedPrompt }),
  };
}
