import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.js";
import {
  bananaEnv,
  type MockBehavior,
  parseData,
  parseError,
  REAL_PNG,
  requestJson,
  sequence,
  startMock,
} from "./helpers/provider-mock.js";

vi.setConfig({ testTimeout: 30_000 });

describe("banana-image e2e", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "banana-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generations 默认 quality=low：b64 落盘、请求体契约正确、真实尺寸不符给警告", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    const out = path.join(dir, "gen.jpg");
    const run = await cli(
      ["--json", "banana-image-gen", "--prompt", "一只猫", "--output", out],
      bananaEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toEqual({
      path: out,
      bytes: REAL_PNG.length,
      // mock 回的是 PNG 字节：format 是 sharp 解出的真值，不跟随请求的 jpeg
      format: "png",
      size: "8x16",
      requestedSize: "1024x1024",
      model: "gpt-image-2",
      quality: "low",
      qualityDefault: "low",
      moderation: "low",
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].path).toBe("/v1/images/generations");
    expect(mock.requests[0].key).toBe("banana-test-key");
    expect(requestJson(mock)).toMatchObject({
      model: "gpt-image-2",
      prompt: "一只猫",
      size: "1024x1024",
      quality: "low",
      moderation: "low",
      output_format: "jpeg",
      n: 1,
    });
    const warnings = (JSON.parse(run.stdout) as { warnings: { code: string; plugin: string }[] })
      .warnings;
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "E_SIZE_MISMATCH", plugin: "banana-image" }),
    );
    expect(await readFile(out)).toEqual(REAL_PNG);
    expect(run.stdout).not.toContain("banana-test-key");
    await mock.close();
  });

  it("--ref 本地文件走 multipart edits，字段与参考图都进请求体", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    const ref = path.join(dir, "ref.png");
    await writeFile(ref, REAL_PNG);
    const out = path.join(dir, "edit.png");
    const run = await cli(
      [
        "--json",
        "banana-image-gen",
        "--prompt",
        "把背景换成海边",
        "--ref",
        ref,
        "--size",
        "auto",
        "--quality",
        "medium",
        "--output",
        out,
      ],
      bananaEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toMatchObject({
      path: out,
      size: "8x16",
      requestedSize: "auto",
      quality: "medium",
      qualityDefault: "low",
    });
    expect(mock.requests[0].path).toBe("/v1/images/edits");
    expect(mock.requests[0].headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = mock.requests[0].body;
    expect(body).toContain('name="image[]"; filename="ref.png"');
    expect(body).toContain('name="model"');
    expect(body).toContain("gpt-image-2");
    expect(body).toContain('name="quality"');
    expect(body).toContain("medium");
    expect(body).toContain("把背景换成海边");
    expect(body).toContain('name="size"');
    expect(body).toContain("auto");
    // --size auto 不应因真实像素不同而报警
    const warnings = (JSON.parse(run.stdout) as { warnings: { code: string }[] }).warnings;
    expect(warnings.map((w) => w.code)).not.toContain("E_SIZE_MISMATCH");
    await mock.close();
  });

  it("--ref 传 http(s) URL：改走 JSON images，URL 原样交给网关下载", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    const out = path.join(dir, "url-refs.png");
    const run = await cli(
      [
        "--json",
        "banana-image-gen",
        "--prompt",
        "把 <Image 1> 放进 <Image 2> 的场景",
        "--ref",
        "https://cdn.example.com/a.png",
        "https://cdn.example.com/b.jpg",
        "--output",
        out,
      ],
      bananaEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(mock.requests[0].path).toBe("/v1/images/edits");
    expect(mock.requests[0].headers["content-type"]).toBe("application/json");
    expect(requestJson(mock)).toMatchObject({
      model: "gpt-image-2",
      images: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.jpg"],
      moderation: "low",
    });
    expect(requestJson(mock)).not.toHaveProperty("n");
    await mock.close();
  });

  it("URL 与本地文件混传：本地内联 data URI，base64 绝不进 stdout", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    const ref = path.join(dir, "local.png");
    await writeFile(ref, REAL_PNG);
    const out = path.join(dir, "mixed.png");
    const run = await cli(
      [
        "--json",
        "banana-image-gen",
        "--prompt",
        "x",
        "--ref",
        "https://cdn.example.com/a.png",
        ref,
        "--output",
        out,
      ],
      bananaEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    const images = requestJson(mock).images as string[];
    expect(images[0]).toBe("https://cdn.example.com/a.png");
    expect(images[1]).toBe(`data:image/png;base64,${REAL_PNG.toString("base64")}`);
    expect(run.stdout).not.toContain(REAL_PNG.toString("base64"));
    await mock.close();
  });

  it("带 scheme 的非 http(s) 入参本地拒（网关会把它当 base64，报错误导排查）", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    for (const value of ["file:///tmp/a.png", "data:image/png;base64,AAAA"]) {
      const run = await cli(
        ["--json", "banana-image-gen", "--prompt", "x", "--ref", value],
        bananaEnv(mock.endpoint),
      );
      expect(run.code).toBe(2);
      expect(parseError(run).code).toBe("E_INVALID_OPTION");
      expect(parseError(run).message).toContain("--ref");
    }
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("--moderation 覆盖 env 默认；非法值零请求", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    const out = path.join(dir, "mod.png");
    const ok = await cli(
      ["--json", "banana-image-gen", "--prompt", "x", "--moderation", "auto", "--output", out],
      bananaEnv(mock.endpoint),
    );
    expect(ok.code).toBe(0);
    expect(parseData(ok)).toMatchObject({ moderation: "auto" });
    expect(requestJson(mock, 0).moderation).toBe("auto");

    const byEnv = await cli(
      ["--json", "banana-image-gen", "--prompt", "x", "--output", out],
      bananaEnv(mock.endpoint, { BANANA_IMAGE_MODERATION: "auto" }),
    );
    expect(byEnv.code).toBe(0);
    expect(requestJson(mock, 1).moderation).toBe("auto");

    const bad = await cli(
      ["--json", "banana-image-gen", "--prompt", "x", "--moderation", "low-medium"],
      bananaEnv(mock.endpoint),
    );
    expect(bad.code).toBe(2);
    expect(parseError(bad).code).toBe("E_INVALID_OPTION");
    expect(mock.requests).toHaveLength(2);
    await mock.close();
  });

  it("URL 响应会无鉴权下载并回传 sourceUrl", async () => {
    const behavior: MockBehavior = (req, endpoint) => {
      if (req.path === "/v1/images/generations") {
        return { body: { data: [{ url: `${endpoint}/files/out.png` }] } };
      }
      if (req.path === "/files/out.png") {
        return { binary: REAL_PNG, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "unexpected path" } } };
    };
    const mock = await startMock(behavior);
    const out = path.join(dir, "url.png");
    const run = await cli(
      ["--json", "banana-image-gen", "--prompt", "p", "--output", out],
      bananaEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toMatchObject({
      path: out,
      sourceUrl: `${mock.endpoint}/files/out.png`,
    });
    expect(mock.requests[1].path).toBe("/files/out.png");
    expect(mock.requests[1].key).toBe("");
    expect(await readFile(out)).toEqual(REAL_PNG);
    await mock.close();
  });

  it("401 → E_CONFIG 且只请求一次，错误里不带 key 原文", async () => {
    const mock = await startMock(
      sequence([{ status: 401, body: { error: { message: "invalid api key banana-test-key" } } }]),
    );
    const run = await cli(
      ["--json", "banana-image-gen", "--prompt", "p", "--output", path.join(dir, "x.png")],
      bananaEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_CONFIG");
    expect(error.details?.var).toBe("BANANA_IMAGE_API_KEY");
    expect(mock.requests).toHaveLength(1);
    expect(run.stdout).not.toContain("banana-test-key");
    await mock.close();
  });

  it("本地校验零请求：缺 prompt、非法 size、缺 key", async () => {
    const mock = await startMock(() => ({ body: { data: [] } }));
    const noPrompt = await cli(
      ["--json", "banana-image-gen", "--output", path.join(dir, "x.png")],
      bananaEnv(mock.endpoint),
    );
    expect(noPrompt.code).toBe(2);
    expect(parseError(noPrompt).code).toBe("E_MISSING_ARGUMENT");

    const badSize = await cli(
      [
        "--json",
        "banana-image-gen",
        "--prompt",
        "p",
        "--size",
        "1023x1024",
        "--output",
        path.join(dir, "x.png"),
      ],
      bananaEnv(mock.endpoint),
    );
    expect(badSize.code).toBe(2);
    expect(parseError(badSize).code).toBe("E_INVALID_OPTION");

    const noKey = await cli(["--json", "banana-image-gen", "--prompt", "p"], {
      ...bananaEnv(mock.endpoint),
      BANANA_IMAGE_API_KEY: "",
    });
    expect(noKey.code).toBe(3);
    expect(parseError(noKey).code).toBe("E_CONFIG");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("spec 列出 banana-image-gen 的全部选项", async () => {
    const run = await cli(["--json", "spec"]);
    expect(run.code).toBe(0);
    const spec = parseData<{
      commands: { name: string; source: string; options?: { flags: string }[] }[];
    }>(run);
    const command = spec.commands.find((item) => item.name === "banana-image-gen");
    expect(command?.source).toBe("plugin:banana-image");
    expect(command?.options?.map((option) => option.flags)).toEqual([
      "--prompt <text>",
      "--ref <urlsOrPaths...>",
      "--size <WxH|auto>",
      "--quality <q>",
      "--moderation <m>",
      "--output <path>",
      "--model <id>",
    ]);
  });
});
