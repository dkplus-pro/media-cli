import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.js";
import {
  minimaxEnv,
  parseData,
  parseError,
  requestJson,
  startMock,
} from "./helpers/provider-mock.js";

vi.setConfig({ testTimeout: 30_000 });
let PNG_1024: Buffer;
let PNG_2048X1152: Buffer;
let dir = "";

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#335577" } })
    .png()
    .toBuffer();
}
function env(endpoint: string): Record<string, string | undefined> {
  // 本机可能残留 MINIMAX_IMAGE_MODEL：显式删除，保证默认模型断言稳定
  return minimaxEnv(endpoint, { MINIMAX_IMAGE_MODEL: undefined });
}
describe("minimax-image e2e（本地 mock）", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minimax-image-e2e-"));
    PNG_1024 = await makePng(1024, 1024);
    PNG_2048X1152 = await makePng(2048, 1152);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("文生图：POST /v1/images/generations，请求体只含显式字段，直链下载不带鉴权", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.path === "/v1/images/generations") {
        return {
          body: {
            created: 1,
            data: [
              {
                url: `${endpoint}/result.png`,
                size: "1024x1024",
                revised_prompt: "a cat sitting",
              },
            ],
            output_format: "jpeg",
          },
        };
      }
      if (req.path === "/result.png") {
        return { binary: PNG_1024, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "not found" } } };
    });
    try {
      const out = path.join(dir, "t2i.jpeg");
      const run = await cli(
        ["--json", "minimax-image", "--prompt", "一只猫", "--output", out],
        env(mock.endpoint),
      );
      expect(run.code).toBe(0);
      expect(parseData(run)).toEqual({
        path: out,
        bytes: PNG_1024.length,
        model: "MiniMax-H3-Image",
        size: "1024x1024",
        revisedPrompt: "a cat sitting",
        outputFormat: "jpeg",
      });
      expect(await readFile(out)).toEqual(PNG_1024);
      expect(run.stdout).not.toContain("minimax-test-key");

      expect(mock.requests).toHaveLength(2);
      expect(mock.requests[0].method).toBe("POST");
      expect(mock.requests[0].path).toBe("/v1/images/generations");
      expect(mock.requests[0].key).toBe("minimax-test-key");
      expect(requestJson(mock)).toEqual({
        model: "MiniMax-H3-Image",
        prompt: "一只猫",
        size: "1024x1024",
        output_format: "jpeg",
      });
      // 结果 URL 是对象存储直链：不带 Authorization
      expect(mock.requests[1].path).toBe("/result.png");
      expect(mock.requests[1].headers.authorization).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it("图生图/编辑：--ref 本地 PNG 内联，走 POST /v1/images/edits", async () => {
    const refPath = path.join(dir, "ref.png");
    await sharp({ create: { width: 512, height: 512, channels: 3, background: "#996633" } })
      .png()
      .toFile(refPath);
    const mock = await startMock((req, endpoint) => {
      if (req.path === "/v1/images/edits") {
        return { body: { data: [{ url: `${endpoint}/edited.png`, size: "1024x1024" }] } };
      }
      if (req.path === "/edited.png") {
        return { binary: PNG_1024, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "not found" } } };
    });
    try {
      const out = path.join(dir, "edited.jpeg");
      const run = await cli(
        ["--json", "minimax-image", "--prompt", "换成水彩风格", "--ref", refPath, "--output", out],
        env(mock.endpoint),
      );
      expect(run.code).toBe(0);
      const data = parseData<{ refs: string[]; refCount: number; size: string }>(run);
      expect(data.refCount).toBe(1);
      expect(data.size).toBe("1024x1024");
      expect(data.refs[0]).toMatch(/^data:image\/png;base64,\d+ bytes$/);

      expect(mock.requests[0].path).toBe("/v1/images/edits");
      expect(requestJson(mock)).toEqual({
        model: "MiniMax-H3-Image",
        prompt: "换成水彩风格",
        size: "1024x1024",
        output_format: "jpeg",
        images: [{ image_url: expect.stringMatching(/^data:image\/png;base64,/) }],
      });
    } finally {
      await mock.close();
    }
  });

  it("b64_json 兜底 + 显式尺寸不符：落盘实际像素并带 E_SIZE_MISMATCH", async () => {
    const mock = await startMock(() => ({
      body: { data: [{ b64_json: PNG_1024.toString("base64"), size: "1024x1024" }] },
    }));
    try {
      const out = path.join(dir, "b64.jpeg");
      const run = await cli(
        ["--json", "minimax-image", "--prompt", "p", "--size", "2048x2048", "--output", out],
        env(mock.endpoint),
      );
      expect(run.code).toBe(0);
      expect(await readFile(out)).toEqual(PNG_1024);
      const parsed = JSON.parse(run.stdout) as {
        data: { size: string };
        warnings: { code: string }[];
      };
      expect(parsed.data.size).toBe("1024x1024");
      expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: "E_SIZE_MISMATCH" }));
    } finally {
      await mock.close();
    }
  });

  it("area + aspect 组合：请求体为 size auto + area + aspect_ratio，回真实尺寸", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.path === "/v1/images/generations") {
        return { body: { data: [{ url: `${endpoint}/wide.png`, size: "2048x1152" }] } };
      }
      if (req.path === "/wide.png") {
        return { binary: PNG_2048X1152, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "not found" } } };
    });
    try {
      const out = path.join(dir, "wide.jpeg");
      const run = await cli(
        [
          "--json",
          "minimax-image",
          "--prompt",
          "宽幅海报",
          "--area",
          "2K",
          "--aspect-ratio",
          "16:9",
          "--output",
          out,
        ],
        env(mock.endpoint),
      );
      expect(run.code).toBe(0);
      expect(parseData<{ size: string }>(run).size).toBe("2048x1152");
      expect(requestJson(mock)).toEqual({
        model: "MiniMax-H3-Image",
        prompt: "宽幅海报",
        size: "auto",
        output_format: "jpeg",
        aspect_ratio: "16:9",
        area: "2K",
      });
    } finally {
      await mock.close();
    }
  });

  it("4096x4096 本地通过；webp + 压缩 + 水印都进请求体", async () => {
    const big = await makePng(4096, 4096);
    const mock = await startMock((req, endpoint) => {
      if (req.path === "/v1/images/generations") {
        return { body: { data: [{ url: `${endpoint}/big.png`, size: "4096x4096" }] } };
      }
      if (req.path === "/big.png") {
        return { binary: big, headers: { "content-type": "image/png" } };
      }
      return { status: 404, body: { error: { message: "not found" } } };
    });
    try {
      const out = path.join(dir, "big.webp");
      const run = await cli(
        [
          "--json",
          "minimax-image",
          "--prompt",
          "城市夜景",
          "--size",
          "4096x4096",
          "--output-format",
          "webp",
          "--output-compression",
          "80",
          "--aigc-watermark",
          "--output",
          out,
        ],
        env(mock.endpoint),
      );
      expect(run.code).toBe(0);
      expect(parseData<{ size: string; outputFormat: string; bytes: number }>(run)).toMatchObject({
        size: "4096x4096",
        outputFormat: "webp",
        bytes: big.length,
      });
      expect(requestJson(mock)).toEqual({
        model: "MiniMax-H3-Image",
        prompt: "城市夜景",
        size: "4096x4096",
        output_format: "webp",
        output_compression: 80,
        aigc_watermark: true,
      });
    } finally {
      await mock.close();
    }
  });

  it("单项失败 code 1027（HTTP 200）→ E_PROVIDER_ERROR + content_safety", async () => {
    const mock = await startMock(() => ({
      body: {
        created: 1,
        data: [{ error: { code: 1027, message: "content safety triggered" } }],
      },
    }));
    try {
      const run = await cli(
        [
          "--json",
          "minimax-image",
          "--prompt",
          "违规内容",
          "--output",
          path.join(dir, "blocked.jpeg"),
        ],
        env(mock.endpoint),
      );
      expect(run.code).toBe(3);
      const error = parseError(run);
      expect(error.code).toBe("E_PROVIDER_ERROR");
      expect(error.details?.reason).toBe("content_safety");
      expect(error.details?.imageErrorCode).toBe(1027);
      expect(error.message).toContain("content safety triggered");
      expect(mock.requests).toHaveLength(1);
      expect(run.stdout).not.toContain("minimax-test-key");
    } finally {
      await mock.close();
    }
  });

  it("缺 --prompt → 退出码 2 / E_MISSING_ARGUMENT，且不发任何请求", async () => {
    const mock = await startMock(() => ({ body: { data: [] } }));
    try {
      const run = await cli(
        ["--json", "minimax-image", "--output", path.join(dir, "missing.jpeg")],
        env(mock.endpoint),
      );
      expect(run.code).toBe(2);
      expect(parseError(run).code).toBe("E_MISSING_ARGUMENT");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});
