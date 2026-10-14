import { describe, expect, it } from "vitest";
import { loadPool } from "../../plugins/tencent-cos/lib/env.mjs";

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

function catchConfig(env: Record<string, string>, explicit?: string): CliErr {
  try {
    loadPool(explicit, env);
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected E_CONFIG");
}

const BASE = {
  TENCENT_SECRET_ID: "sid-test-value",
  TENCENT_SECRET_KEY: "skey-test-value",
  COS_REGION: "ap-guangzhou",
  COS_ENV: "prod",
  COS_PROD_BUCKET: "ai4love-1300000000",
  COS_PROD_PREFIX: "tmp/",
  CDN_PURGE_URL_PROD: "https://cdn.ai4love.cn/tmp/dist/index.html",
  COS_TEST_BUCKET: "ai4love-dev-1300000000",
  COS_TEST_PREFIX: "tmp/dev/",
  CDN_PURGE_URL_TEST: "https://devcdn.ai4love.cn/tmp/dist/index.html",
};

describe("tencent-cos 池配置", () => {
  it("prod 池：bucket / 前缀 / 公网域名取自 CDN_PURGE_URL_PROD 的 origin", () => {
    const pool = loadPool(undefined, BASE);
    expect(pool).toMatchObject({
      name: "prod",
      bucket: "ai4love-1300000000",
      prefix: "tmp/",
      publicBase: "https://cdn.ai4love.cn",
      region: "ap-guangzhou",
      timeoutMs: 120000,
    });
  });

  it("--env test 覆盖 COS_ENV，改用 test 池的桶、前缀与域名", () => {
    const pool = loadPool("test", BASE);
    expect(pool).toMatchObject({
      name: "test",
      bucket: "ai4love-dev-1300000000",
      prefix: "tmp/dev/",
      publicBase: "https://devcdn.ai4love.cn",
    });
  });

  it("前缀归一：空值=根目录，缺斜杠补斜杠，多余斜杠剥掉", () => {
    expect(loadPool(undefined, { ...BASE, COS_PROD_PREFIX: "" }).prefix).toBe("");
    expect(loadPool(undefined, { ...BASE, COS_PROD_PREFIX: "tmp" }).prefix).toBe("tmp/");
    expect(loadPool(undefined, { ...BASE, COS_PROD_PREFIX: "tmp//a//" }).prefix).toBe("tmp/a/");
  });

  it("未指定池（无 COS_ENV 且无 --env）→ E_CONFIG，且不写默认池", () => {
    const { COS_ENV: _omit, ...rest } = BASE;
    const err = catchConfig(rest);
    expect(err.code).toBe("E_CONFIG");
    expect(err.details?.var).toBe("COS_ENV");
  });

  it("非法池名 / 缺凭据 / 缺桶 / CDN URL 非 URL 均 E_CONFIG", () => {
    expect(catchConfig(BASE, "staging").code).toBe("E_CONFIG");
    const { TENCENT_SECRET_KEY: _k, ...noKey } = BASE;
    expect(catchConfig(noKey).details?.var).toBe("TENCENT_SECRET_KEY");
    const { COS_PROD_BUCKET: _b, ...noBucket } = BASE;
    expect(catchConfig(noBucket).details?.var).toBe("COS_PROD_BUCKET");
    const { CDN_PURGE_URL_PROD: _u, ...noUrl } = BASE;
    expect(catchConfig(noUrl).details?.var).toBe("CDN_PURGE_URL_PROD");
    expect(catchConfig({ ...BASE, CDN_PURGE_URL_PROD: "cdn.ai4love.cn" }).code).toBe("E_CONFIG");
    expect(catchConfig({ ...BASE, CDN_PURGE_URL_PROD: "ftp://cdn.ai4love.cn" }).code).toBe(
      "E_CONFIG",
    );
    expect(catchConfig({ ...BASE, COS_PROD_PREFIX: "/tmp/" }).details?.var).toBe("COS_PROD_PREFIX");
    expect(catchConfig({ ...BASE, TENCENT_COS_TIMEOUT_MS: "0" }).details?.var).toBe(
      "TENCENT_COS_TIMEOUT_MS",
    );
  });

  it("TENCENT_COS_DOMAIN 存在时用于自测指向", () => {
    expect(loadPool(undefined, { ...BASE, TENCENT_COS_DOMAIN: "127.0.0.1:8080" }).domain).toBe(
      "127.0.0.1:8080",
    );
    expect(loadPool(undefined, BASE).domain).toBeUndefined();
  });
});
