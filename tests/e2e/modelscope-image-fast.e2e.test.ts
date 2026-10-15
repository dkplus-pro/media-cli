import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.ts";
import { type Mock, msEnv, parseError, refStub, startMock } from "./helpers/modelscope-mock.ts";

// spawn 真进程的 e2e：全量并发时单条会超过 vitest 默认 5s（实测 F7 字号用例在满载下超时），
// 故整文件设 30s 上限，与仓库既有慢用例显式 `, 30000)` 的口径一致。
vi.setConfig({ testTimeout: 30_000 });

const TURBO = "Qwen/Qwen-Image-2.1-Turbo";
const BASE_MODEL = "Qwen/Qwen-Image-2.1";
const KEY = "ms-test-secret-key";

let dir: string;
const file = (name: string) => path.join(dir, name);
type Env = Record<string, string | undefined>;

// 默认删掉继承来的 MODELSCOPE_FAST_MODEL（helpers/cli.ts 里 undefined = 从继承环境删除），
// 否则本机 ~/.zshrc 一旦配了这个变量，就测不到「内置默认模型是 Turbo」这条契约
function run(command: string, mock: Mock, args: string[], extra: Env = {}, cwd?: string) {
  return cli(
    ["--json", command, ...args],
    msEnv(mock.endpoint, { MODELSCOPE_FAST_MODEL: undefined, ...extra }),
    cwd,
  );
}

const fast = (mock: Mock, args: string[], extra?: Env, cwd?: string) =>
  run("modelscope-image-fast", mock, args, extra, cwd);
const gen = (mock: Mock, args: string[], extra?: Env, cwd?: string) =>
  run("modelscope-image-gen", mock, args, extra, cwd);

function bodyOf(req: { body: string } | undefined): Record<string, unknown> {
  return JSON.parse(req?.body ?? "{}") as Record<string, unknown>;
}

const lastBody = (mock: Mock) => bodyOf(mock.requests[mock.requests.length - 1]);

function dataOf(r: { stdout: string }): Record<string, unknown> {
  return (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
}

describe("modelscope-image-fast e2e（本地 mock，§4.2 默认值）", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-fast-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("默认值全部落进请求体：Turbo + steps=8 + guidance=1 + 2048x2048", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await fast(mock, ["--prompt", "一只红苹果", "--output", file("fast-defaults.png")]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0])).toEqual({
        model: TURBO,
        prompt: "一只红苹果",
        size: "2048x2048",
        steps: 8,
        guidance: 1,
      });
      expect(dataOf(r)).toMatchObject({ model: TURBO, size: "2048x2048" });
      expect((await readFile(file("fast-defaults.png"))).length).toBeGreaterThan(0);
      expect(mock.requests).toHaveLength(1);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("guidance 下限已从 1.5 放宽到 1（两个命令都收 Turbo 官方 CFG=1）", async () => {
    const mock = await startMock(refStub);
    try {
      // §4.2-1 要求两个命令同时放宽；改下限前这两次都会 E_INVALID_OPTION（退出码 2）
      for (const [command, name] of [
        ["modelscope-image-fast", "g-fast.png"],
        ["modelscope-image-gen", "g-gen.png"],
      ] as const) {
        const args = ["--prompt", "x", "--guidance", "1", "--output", file(name)];
        const r = await run(command, mock, args);
        expect(r.code).toBe(0);
        expect(lastBody(mock).guidance).toBe(1);
      }
      const below = await fast(mock, ["--prompt", "x", "--guidance", "0.9"]);
      expect(below.code).toBe(2);
      expect(parseError(below).code).toBe("E_INVALID_OPTION");
      expect(mock.requests).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it("prompt 4001 字符被本地预检拦下（两个命令共用），完全不发网络", async () => {
    const mock = await startMock(refStub);
    try {
      for (const command of ["modelscope-image-fast", "modelscope-image-gen"]) {
        const r = await run(command, mock, ["--prompt", "a".repeat(4001)]);
        expect(r.code).toBe(2);
        const err = parseError(r);
        expect(err.code).toBe("E_INVALID_OPTION");
        expect(err.details).toMatchObject({ option: "--prompt", limit: 4000, actual: 4001 });
        expect(err.message).toContain("4000");
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("4000 个汉字（=12000 UTF-8 字节）照常放行：上限按字符不按字节", async () => {
    const mock = await startMock(refStub);
    try {
      const prompt = "苹".repeat(4000);
      expect(Buffer.byteLength(prompt, "utf8")).toBe(12000);
      const r = await fast(mock, ["--prompt", prompt, "--output", file("cjk-4000.png")]);
      expect(r.code).toBe(0);
      expect(String(bodyOf(mock.requests[0]).prompt)).toHaveLength(4000);
      expect(mock.requests.some((q) => q.path === "/v1/images/generations")).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("MODELSCOPE_FAST_MODEL 覆盖内置默认，--model 再覆盖 env，且不影响 gen", async () => {
    const mock = await startMock(refStub);
    const env: Env = { MODELSCOPE_FAST_MODEL: "Custom/Fast-Model" };
    try {
      const byEnv = await fast(mock, ["--prompt", "x", "--output", file("a.png")], env);
      expect(byEnv.code).toBe(0);
      expect(bodyOf(mock.requests[0]).model).toBe("Custom/Fast-Model");

      const byFlag = await fast(
        mock,
        ["--prompt", "x", "--model", "Flag/Model", "--output", file("b.png")],
        env,
      );
      expect(byFlag.code).toBe(0);
      expect(bodyOf(mock.requests[1]).model).toBe("Flag/Model");

      // 两条命令的模型变量互不串门：gen 仍然只认 MODELSCOPE_IMAGE_MODEL
      const genRun = await gen(mock, ["--prompt", "x", "--output", file("c.png")], env);
      expect(genRun.code).toBe(0);
      expect(bodyOf(mock.requests[2]).model).toBe(BASE_MODEL);
    } finally {
      await mock.close();
    }
  });

  it("显式选项覆盖 fast 默认，--ratio 仍可用且与 --size 二选一", async () => {
    const mock = await startMock(refStub);
    try {
      const args = [
        "--prompt",
        "x",
        "--size",
        "1024x1024",
        "--steps",
        "40",
        "--guidance",
        "3.5",
        "--seed",
        "12345",
        "--negative-prompt",
        "blurry",
        "--output",
        file("override.png"),
      ];
      const r = await fast(mock, args);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0])).toEqual({
        model: TURBO,
        prompt: "x",
        size: "1024x1024",
        steps: 40,
        guidance: 3.5,
        seed: 12345,
        negative_prompt: "blurry",
      });

      const ratioArgs = ["--prompt", "x", "--ratio", "16:9", "--output", file("ratio.png")];
      const ratio = await fast(mock, ratioArgs);
      expect(ratio.code).toBe(0);
      expect(lastBody(mock).size).toBe("2048x1152");

      const conflict = await fast(mock, ["--prompt", "x", "--size", "1024x1024", "--ratio", "1:1"]);
      expect(conflict.code).toBe(2);
      expect(parseError(conflict).code).toBe("E_INVALID_OPTION");
      expect(mock.requests).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it("异步任务链路 + 默认输出名前缀 modelscope-fast-，输出不含 key", async () => {
    const mock = await startMock((req, endpoint) =>
      req.path === "/v1/images/generations"
        ? { status: 200, body: { task_status: "PENDING", task_id: "fast-task" } }
        : req.path === "/v1/tasks/fast-task"
          ? {
              status: 200,
              body: { task_status: "SUCCEED", output_images: [`${endpoint}/fast.png`] },
            }
          : { status: 200, body: "PNG" },
    );
    try {
      const outDir = file("default-out");
      await mkdir(outDir, { recursive: true });
      // 不传 --output：默认文件名走 fast 的前缀，落在 cwd
      const r = await fast(mock, ["--prompt", "x"], undefined, outDir);
      expect(r.code).toBe(0);
      const data = dataOf(r);
      expect(data.taskId).toBe("fast-task");
      expect(String(data.sourceUrl)).toContain("/fast.png");
      expect(path.basename(String(data.path))).toMatch(/^modelscope-fast-.+\.png$/);
      expect(path.dirname(String(data.path))).toBe(await realpath(outDir));
      expect((await readFile(String(data.path))).length).toBeGreaterThan(0);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("gen 的默认值没被 fast 带歪：不发 steps/guidance、仍 1024x1024、前缀 modelscope-", async () => {
    const mock = await startMock(refStub);
    try {
      const outDir = file("gen-untouched");
      await mkdir(outDir, { recursive: true });
      // gen 即使被设了 MODELSCOPE_FAST_MODEL 也不该受影响
      const r = await gen(mock, ["--prompt", "x"], { MODELSCOPE_FAST_MODEL: TURBO }, outDir);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0])).toEqual({
        model: BASE_MODEL,
        prompt: "x",
        size: "1024x1024",
      });
      const data = dataOf(r);
      const name = path.basename(String(data.path));
      expect(name).toMatch(/^modelscope-\d.*\.png$/);
      expect(name).not.toMatch(/^modelscope-fast-/);
      expect(data.size).toBe("1024x1024");
    } finally {
      await mock.close();
    }
  });

  it("--ref 在 fast 上同样只收公网 URL（多张传数组，本地路径本地拦）", async () => {
    const mock = await startMock(refStub);
    try {
      const urls = ["https://cdn.ai4love.cn/a.png", "https://cdn.ai4love.cn/b.png"];
      const r = await fast(mock, ["--prompt", "x", "--ref", ...urls, "--output", file("ref.png")]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0]).image_url).toEqual(urls);
      expect(dataOf(r).refUrls).toEqual(urls);

      const local = await fast(mock, ["--prompt", "x", "--ref", "/tmp/a.png"]);
      expect(local.code).toBe(2);
      expect(parseError(local).code).toBe("E_INVALID_OPTION");
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });
});
