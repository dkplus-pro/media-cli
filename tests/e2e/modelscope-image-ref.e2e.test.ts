import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./helpers/cli.ts";
import { msEnv, PNG_BYTES, parseError, refStub, startMock } from "./helpers/modelscope-mock.ts";

const A = "https://cdn.ai4love.cn/tmp/multiref/apple-star.png";
const W = "https://cdn.ai4love.cn/tmp/multiref/watermelon-purple.png";
const P = "https://cdn.ai4love.cn/tmp/multiref/plate.png";

describe("modelscope-image-gen --ref（图生图 / 多图参考）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-ref-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("单张参考图：image_url 传字符串（已实测的网关形态）", async () => {
    const mock = await startMock(refStub);
    try {
      const out = path.join(dir, "single.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--ref", A, "--output", out],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(mock.requests[0].body).image_url).toBe(A);
      expect(JSON.parse(r.stdout).data.refUrls).toEqual([A]);
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("多张参考图：image_url 传 URL 数组且顺序与 --ref 一致", async () => {
    // 实测：网关接受数组，两张参考图各自的独有特征（星形标记 / 紫肉方籽）都出现在出图里
    const mock = await startMock(refStub);
    try {
      const out = path.join(dir, "multi.png");
      const r = await cli(
        [
          "--json",
          "modelscope-image-gen",
          "--prompt",
          "把参考图里的水果并排摆放",
          "--ref",
          A,
          W,
          P,
          "--size",
          "1024x1024",
          "--output",
          out,
        ],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(mock.requests[0].body).image_url).toEqual([A, W, P]);
      expect(JSON.parse(r.stdout).data.refUrls).toEqual([A, W, P]);
    } finally {
      await mock.close();
    }
  });

  it("参考图上限 10 张：第 11 张本地即拒，不发请求", async () => {
    const mock = await startMock(refStub);
    try {
      const urls = Array.from({ length: 11 }, (_, i) => `https://cdn.ai4love.cn/tmp/${i}.png`);
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--ref", ...urls],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.message).toContain("10");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("参考图只收 http(s) URL：本地路径不做隐式上传（含多图中的非法项）", async () => {
    const mock = await startMock(refStub);
    try {
      const badRefs = [["/tmp/a.png"], ["./a.png"], ["ftp://cdn/a.png"], [A, "/tmp/b.png"]];
      for (const refs of badRefs) {
        const r = await cli(
          ["--json", "modelscope-image-gen", "--prompt", "x", "--ref", ...refs],
          msEnv(mock.endpoint),
        );
        expect(r.code).toBe(2);
        expect(parseError(r).code).toBe("E_INVALID_OPTION");
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});
