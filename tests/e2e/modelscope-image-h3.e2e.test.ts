import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.ts";
import {
  type Mock,
  msEnv,
  parseError,
  REAL_PNG,
  refStub,
  startMock,
} from "./helpers/modelscope-mock.ts";

// spawn 真进程的 e2e：全量并发时单条会超过 vitest 默认 5s，故整文件设 30s 上限（同兄弟命令）
vi.setConfig({ testTimeout: 30_000 });

const H3 = "MiniMax/MiniMax-H3-Image";
const KEY = "ms-test-secret-key";
const URL_A = "https://cdn.example.com/ref/a.png";
// 参考图内容：真的 PNG 字节重复 64 次（≈5KB → base64 ≈7000 字符），
// 这样「stdout 里没有长 base64」的断言才有意义，而不是因为原文本来就短
const REF_BYTES = Buffer.concat(Array.from({ length: 64 }, () => REAL_PNG));

let dir: string;
const file = (name: string) => path.join(dir, name);
type Env = Record<string, string | undefined>;

// 默认删掉继承来的 MODELSCOPE_H3_MODEL：不删就测不到「内置默认是 MiniMax/MiniMax-H3-Image」，
// 也可能被本机 ~/.zshrc 的配置带偏；MODELSCOPE_KEY_POOL 已由 msEnv 删除
function run(mock: Mock, args: string[], extra: Env = {}, cwd?: string) {
  return cli(
    ["--json", "modelscope-image-h3", ...args],
    msEnv(mock.endpoint, { MODELSCOPE_H3_MODEL: undefined, ...extra }),
    cwd,
  );
}

function bodyOf(req: { body: string } | undefined): Record<string, unknown> {
  return JSON.parse(req?.body ?? "{}") as Record<string, unknown>;
}

function dataOf(r: { stdout: string }): Record<string, unknown> {
  return (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
}

// 任何 >40 连字符的 base64 段都说明原文被回显进了 stdout（摘要形态是 "…;base64,14 bytes"）
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/;

describe("modelscope-image-h3 e2e（本地 mock，MiniMax-H3-Image 契约）", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-h3-e2e-"));
    await writeFile(file("ref.png"), REF_BYTES);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("文生图请求体恰好是 {model,prompt,size}：不发 steps/guidance/negative_prompt", async () => {
    const mock = await startMock(refStub);
    try {
      const out = file("t2i.png");
      const r = await run(mock, ["--prompt", "一只戴头盔的猫", "--output", out]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0])).toEqual({
        model: H3,
        prompt: "一只戴头盔的猫",
        size: "1024x1024",
      });
      expect(mock.requests).toHaveLength(1);
      const data = dataOf(r);
      expect(data.model).toBe(H3);
      expect(data.size).toBe("1024x1024");
      expect(data.refUrls).toBeUndefined();
      expect(data.refCount).toBeUndefined();
      expect((await readFile(out)).length).toBeGreaterThan(0);
      // key 只出现在请求头，绝不回显
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("--seed 透传（0 与上界也合法），其余字段仍是最小集", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await run(mock, [
        "--prompt",
        "x",
        "--seed",
        "2147483647",
        "--output",
        file("seed.png"),
      ]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0])).toEqual({
        model: H3,
        prompt: "x",
        size: "1024x1024",
        seed: 2147483647,
      });
    } finally {
      await mock.close();
    }
  });

  it("本地 PNG 参考图内联成 data URI：image_url 是原文件字节，data.refCount 正确", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await run(mock, [
        "--prompt",
        "保持五官，只把背景换成海边日落",
        "--ref",
        file("ref.png"),
        "--output",
        file("local.png"),
      ]);
      expect(r.code).toBe(0);
      const body = bodyOf(mock.requests[0]);
      // 单张传字符串形态（多张才传数组，与兄弟命令一致）
      expect(typeof body.image_url).toBe("string");
      expect(String(body.image_url)).toMatch(/^data:image\/png;base64,/);
      const base64 = String(body.image_url).split(",")[1] as string;
      expect(Buffer.from(base64, "base64").equals(REF_BYTES)).toBe(true);
      expect(Object.keys(body).sort()).toEqual(["image_url", "model", "prompt", "size"]);

      const data = dataOf(r);
      expect(data.refCount).toBe(1);
      // 摘要形态：mime + 解码字节数，没有原文
      expect(JSON.stringify(data.refUrls)).toContain("data:image/png;base64,");
      expect(JSON.stringify(data.refUrls)).not.toMatch(BASE64_RUN);
      expect(r.stdout).not.toMatch(BASE64_RUN);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("http(s) 参考图原样透传，data.refUrls 不摘要", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await run(mock, ["--prompt", "x", "--ref", URL_A, "--output", file("url.png")]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0]).image_url).toBe(URL_A);
      expect(dataOf(r)).toMatchObject({ refUrls: [URL_A], refCount: 1 });
    } finally {
      await mock.close();
    }
  });

  it("--ratio 映射（16:9 → 2048x1152）并走同一条请求体", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await run(mock, [
        "--prompt",
        "x",
        "--ratio",
        "16:9",
        "--output",
        file("ratio.png"),
      ]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0])).toMatchObject({ size: "2048x1152" });
      expect(dataOf(r).size).toBe("2048x1152");
    } finally {
      await mock.close();
    }
  });

  it("4096 本地即拒：E_INVALID_OPTION、0 请求，并指向 minimax-image", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await run(mock, ["--prompt", "x", "--size", "4096x4096"]);
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--size", value: "4096x4096" });
      expect(err.message).toContain("2048");
      expect(err.message).toContain("4K");
      expect(err.message).toContain("minimax-image");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("第 17 张参考图本地即拒（上限 16）：0 请求", async () => {
    const mock = await startMock(refStub);
    try {
      const refs = Array.from({ length: 17 }, (_, i) => `https://cdn.example.com/${i}.png`);
      const r = await run(mock, ["--prompt", "x", "--ref", ...refs]);
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--ref", value: 17, max: 16 });
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("缺 --prompt：退出码 2 + E_MISSING_ARGUMENT，0 请求（非交互，绝不挂起）", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await run(mock, []);
      expect(r.code).toBe(2);
      expect(parseError(r).code).toBe("E_MISSING_ARGUMENT");
      expect(parseError(r).details?.option).toBe("--prompt");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});
