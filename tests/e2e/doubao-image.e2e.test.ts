import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.js";
import {
  doubaoImageEnv,
  type MockBehavior,
  parseData,
  parseError,
  REAL_PNG,
  requestJson,
  sequence,
  startMock,
} from "./helpers/provider-mock.js";

vi.setConfig({ testTimeout: 30_000 });

const MODEL = "doubao-seedream-4-5-251128";

describe("doubao-image-gen e2e", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "doubao-image-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("默认模型/尺寸/水印：URL 响应无鉴权下载落盘，真实像素不符给警告", async () => {
    const behavior: MockBehavior = (req, endpoint) => {
      if (req.path === "/images/generations") {
        return {
          body: {
            data: [{ url: `${endpoint}/files/out.jpeg` }],
            usage: { generated_images: 1, output_tokens: 100 },
          },
        };
      }
      if (req.path === "/files/out.jpeg") {
        return { binary: REAL_PNG, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "unexpected path" } } };
    };
    const mock = await startMock(behavior);
    const out = path.join(dir, "a.jpeg");
    const run = await cli(
      ["--json", "doubao-image-gen", "--prompt", "一只猫", "--output", out],
      doubaoImageEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toEqual({
      path: out,
      bytes: REAL_PNG.length,
      model: MODEL,
      size: "8x16",
      requestedSize: "2048x2048",
      sourceUrl: `${mock.endpoint}/files/out.jpeg`,
      usage: { generated_images: 1, output_tokens: 100 },
    });
    expect(requestJson(mock)).toEqual({
      model: MODEL,
      prompt: "一只猫",
      size: "2048x2048",
      response_format: "url",
      watermark: false,
      sequential_image_generation: "disabled",
    });
    expect(mock.requests[0].key).toBe("doubao-test-key");
    expect(mock.requests[1].path).toBe("/files/out.jpeg");
    expect(mock.requests[1].key).toBe("");
    expect(await readFile(out)).toEqual(REAL_PNG);
    const warnings = (JSON.parse(run.stdout) as { warnings: { code: string; plugin: string }[] })
      .warnings;
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "E_SIZE_MISMATCH", plugin: "doubao" }),
    );
    await mock.close();
  });

  it("--model 覆盖 env、--watermark 开启、b64 响应直接落盘", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    const out = path.join(dir, "b.jpeg");
    const run = await cli(
      [
        "--json",
        "doubao-image-gen",
        "--prompt",
        "p",
        "--model",
        "custom-seedream",
        "--size",
        "2560x1440",
        "--watermark",
        "--output",
        out,
      ],
      doubaoImageEnv(mock.endpoint, { DOUBAO_IMAGE_MODEL: "env-model" }),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toMatchObject({ model: "custom-seedream", requestedSize: "2560x1440" });
    expect(requestJson(mock)).toMatchObject({
      model: "custom-seedream",
      size: "2560x1440",
      watermark: true,
    });
    expect(parseData(run)).not.toHaveProperty("sourceUrl");
    await mock.close();
  });

  it("本地校验零请求：缺 prompt、像素不足、父目录不存在、缺 key", async () => {
    const mock = await startMock(() => ({ body: { data: [] } }));
    const out = path.join(dir, "x.jpeg");

    const noPrompt = await cli(
      ["--json", "doubao-image-gen", "--output", out],
      doubaoImageEnv(mock.endpoint),
    );
    expect(noPrompt.code).toBe(2);
    expect(parseError(noPrompt).code).toBe("E_MISSING_ARGUMENT");

    const small = await cli(
      ["--json", "doubao-image-gen", "--prompt", "p", "--size", "1024x1024", "--output", out],
      doubaoImageEnv(mock.endpoint),
    );
    expect(small.code).toBe(2);
    expect(parseError(small).code).toBe("E_INVALID_OPTION");

    const badParent = await cli(
      [
        "--json",
        "doubao-image-gen",
        "--prompt",
        "p",
        "--output",
        path.join(dir, "missing", "x.jpeg"),
      ],
      doubaoImageEnv(mock.endpoint),
    );
    expect(badParent.code).toBe(2);
    expect(parseError(badParent).code).toBe("E_INVALID_OPTION");

    const noKey = await cli(["--json", "doubao-image-gen", "--prompt", "p", "--output", out], {
      ...doubaoImageEnv(mock.endpoint),
      DOUBAO_API_KEY: "",
    });
    expect(noKey.code).toBe(3);
    expect(parseError(noKey).code).toBe("E_CONFIG");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("401 → E_CONFIG 且只请求一次，错误里不带 key 原文", async () => {
    const mock = await startMock(
      sequence([{ status: 401, body: { error: { message: "invalid key doubao-test-key" } } }]),
    );
    const run = await cli(
      ["--json", "doubao-image-gen", "--prompt", "p", "--output", path.join(dir, "denied.jpeg")],
      doubaoImageEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_CONFIG");
    expect(error.details?.var).toBe("DOUBAO_API_KEY");
    expect(mock.requests).toHaveLength(1);
    expect(run.stdout).not.toContain("doubao-test-key");
    await mock.close();
  });

  it("provider 400 → E_PROVIDER_ERROR 且带响应体信息", async () => {
    const mock = await startMock(
      sequence([{ status: 400, body: { error: { message: "invalid size for model" } } }]),
    );
    const run = await cli(
      ["--json", "doubao-image-gen", "--prompt", "p", "--output", path.join(dir, "bad.jpeg")],
      doubaoImageEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_PROVIDER_ERROR");
    expect(error.details).toMatchObject({
      source: "doubao-image",
      status: 400,
      providerMessage: "invalid size for model",
    });
    await mock.close();
  });

  it("--ref 本地文件：读成 data URI 内联提交，结果只回摘要不回 base64", async () => {
    const behavior: MockBehavior = (req, endpoint) => {
      if (req.path === "/images/generations") {
        return { body: { data: [{ url: `${endpoint}/files/out.jpeg` }] } };
      }
      if (req.path === "/files/out.jpeg") {
        return { binary: REAL_PNG, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "unexpected path" } } };
    };
    const mock = await startMock(behavior);
    await writeFile(path.join(dir, "ref.png"), REAL_PNG);
    const run = await cli(
      [
        "--json",
        "doubao-image-gen",
        "--prompt",
        "改成夜景",
        "--ref",
        "ref.png",
        "--output",
        path.join(dir, "edit.jpeg"),
      ],
      doubaoImageEnv(mock.endpoint),
      dir,
    );
    expect(run.code).toBe(0);
    expect(requestJson(mock)).toMatchObject({
      image: `data:image/png;base64,${REAL_PNG.toString("base64")}`,
    });
    expect(parseData(run)).toMatchObject({
      refs: [`data:image/png;base64,${REAL_PNG.length} bytes`],
    });
    expect(run.stdout).not.toContain(REAL_PNG.toString("base64"));
    await mock.close();
  });

  it("多张 --ref → image 为数组；http(s) 项原样透传不读盘", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    await writeFile(path.join(dir, "ref.png"), REAL_PNG);
    const run = await cli(
      [
        "--json",
        "doubao-image-gen",
        "--prompt",
        "p",
        "--ref",
        "https://cdn/x.png",
        "ref.png",
        "--output",
        path.join(dir, "multi.jpeg"),
      ],
      doubaoImageEnv(mock.endpoint),
      dir,
    );
    expect(run.code).toBe(0);
    expect(requestJson(mock).image).toEqual([
      "https://cdn/x.png",
      `data:image/png;base64,${REAL_PNG.toString("base64")}`,
    ]);
    expect(parseData(run)).toMatchObject({
      refs: ["https://cdn/x.png", `data:image/png;base64,${REAL_PNG.length} bytes`],
    });
    await mock.close();
  });

  it("参考图读不到 → 本地即拒且不碰网络（不白扣一次生图额度）", async () => {
    const mock = await startMock(() => ({ body: { data: [] } }));
    const missing = await cli(
      [
        "--json",
        "doubao-image-gen",
        "--prompt",
        "p",
        "--ref",
        "nope.png",
        "--output",
        path.join(dir, "n.jpeg"),
      ],
      doubaoImageEnv(mock.endpoint),
      dir,
    );
    expect(missing.code).toBe(2);
    expect(parseError(missing).code).toBe("E_MISSING_ARGUMENT");

    await writeFile(path.join(dir, "bad.svg"), Buffer.from([1]));
    const badExt = await cli(
      [
        "--json",
        "doubao-image-gen",
        "--prompt",
        "p",
        "--ref",
        "bad.svg",
        "--output",
        path.join(dir, "g.jpeg"),
      ],
      doubaoImageEnv(mock.endpoint),
      dir,
    );
    expect(badExt.code).toBe(2);
    expect(parseError(badExt).code).toBe("E_INVALID_OPTION");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("spec 列出 doubao-image-gen 的全部选项", async () => {
    const run = await cli(["--json", "spec"]);
    expect(run.code).toBe(0);
    const spec = parseData<{
      commands: { name: string; source: string; options?: { flags: string }[] }[];
    }>(run);
    const command = spec.commands.find((item) => item.name === "doubao-image-gen");
    expect(command?.source).toBe("plugin:doubao");
    expect(command?.options?.map((option) => option.flags)).toEqual([
      "--prompt <text>",
      "--ref <pathsOrUrls...>",
      "--model <id>",
      "--size <WxH>",
      "--watermark",
      "--output <path>",
      "--timeout <ms>",
    ]);
  });
});
