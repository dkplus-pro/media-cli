import { createReadStream } from "node:fs";
import COS from "cos-nodejs-sdk-v5";
import { cliError } from "./errors.mjs";

function createClient(pool) {
  return new COS({
    SecretId: pool.secretId,
    SecretKey: pool.secretKey,
    ...(pool.domain === undefined ? {} : { Protocol: "http:", Domain: pool.domain }),
  });
}

// 注意：Domain 覆盖时 SDK 的 data.Location 会带上自测 host，公网 URL 一律由调用方拼
function toUploadError(pool, key, err) {
  const details = {
    source: "tencent-cos",
    bucket: pool.bucket,
    key,
    ...(err?.statusCode === undefined ? {} : { status: err.statusCode }),
    ...(err?.code === undefined ? {} : { code: String(err.code) }),
    message: String(err?.message ?? err).slice(0, 300),
  };
  return cliError(
    "E_PROVIDER_ERROR",
    `腾讯云 COS 上传失败：${String(err?.message ?? err).slice(0, 200)}`,
    details,
  );
}

export async function uploadObject(pool, { key, filePath, contentType }) {
  const cos = createClient(pool);
  const task = new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: pool.bucket,
        Region: pool.region,
        Key: key,
        Body: createReadStream(filePath),
        ...(contentType === undefined ? {} : { ContentType: contentType }),
      },
      (err, data) => (err ? reject(err) : resolve(data)),
    );
  });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          cliError("E_PROVIDER_ERROR", `腾讯云 COS 上传超时（${pool.timeoutMs}ms）`, {
            source: "tencent-cos",
            bucket: pool.bucket,
            key,
            hint: "请求可能已到达 COS，重传前先确认该 key 是否已存在",
          }),
        ),
      pool.timeoutMs,
    );
  });

  let data;
  try {
    data = await Promise.race([task, timeout]);
  } catch (err) {
    if (err?.code === "E_PROVIDER_ERROR") throw err;
    throw toUploadError(pool, key, err);
  } finally {
    clearTimeout(timer);
  }
  return { etag: data?.ETag ?? data?.etag };
}
