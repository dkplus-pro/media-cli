import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

// spawn 真进程的 e2e：全量并发时单条会超过 vitest 默认 5s，故整文件设 30s 上限（同 fast 那份）
vi.setConfig({ testTimeout: 30_000 });

const EDIT = "Qwen/Qwen-Image-Edit";
const BASE_MODEL = "Qwen/Qwen-Image-2.1";
const KEY = "ms-test-secret-key";
// 网关实测硬限：image_url 上限 4 张、prompt 4000 字符、每边 [64,2048]、steps [1,50]
const URL_A = "https://cdn.example.com/ref/a.png";
const URL_B = "https://cdn.example.com/ref/b.png";
// 参考图内容：真的 PNG 字节重复 64 次（≈5KB → base64 ≈7000 字符），
// 这样「stdout 里没有长 base64」的断言才有意义，而不是因为原文本来就短
const REF_BYTES = Buffer.concat(Array.from({ length: 64 }, () => REAL_PNG));

let dir: string;
const file = (name: string) => path.join(dir, name);
type Env = Record<string, string | undefined>;

// 默认删掉继承来的 MODELSCOPE_EDIT_MODEL（helpers/cli.ts 里 undefined = 从继承环境删除）：
// 本机 ~/.zshrc 配的是真 ModelScope token 与真模型名，不删就测不到「内置默认是 Qwen/Qwen-Image-Edit」，
// 更可能直接打真网关。同时 MODELSCOPE_KEY_POOL 已由 msEnv 删除。
function run(command: string, mock: Mock, args: string[], extra: Env = {}, cwd?: string) {
  return cli(
    ["--json", command, ...args],
    msEnv(mock.endpoint, { MODELSCOPE_EDIT_MODEL: undefined, ...extra }),
    cwd,
  );
}

const edit = (mock: Mock, args: string[], extra?: Env, cwd?: string) =>
  run("modelscope-image-edit", mock, args, extra, cwd);
const gen = (mock: Mock, args: string[], extra?: Env, cwd?: string) =>
  run("modelscope-image-gen", mock, args, extra, cwd);

function bodyOf(req: { body: string } | undefined): Record<string, unknown> {
  return JSON.parse(req?.body ?? "{}") as Record<string, unknown>;
}

const lastBody = (mock: Mock) => bodyOf(mock.requests[mock.requests.length - 1]);

function dataOf(r: { stdout: string }): Record<string, unknown> {
  return (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
}

// 任何 >40 连字符的 base64 段都说明原文被回显进了 stdout（摘要形态是 "…;base64,14 bytes"）
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/;

describe("modelscope-image-edit e2e（本地 mock，实测 2026-10-15 契约）", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-edit-e2e-"));
    await writeFile(file("ref.png"), REF_BYTES);
    await writeFile(file("ref2.jpg"), REF_BYTES);
    await writeFile(file("notes.txt"), "not an image");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("默认值：模型 Qwen/Qwen-Image-Edit + 2048x2048，且不发 steps/guidance/image_url", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await edit(mock, ["--prompt", "把外套换成红色", "--output", file("default.png")]);
      expect(r.code).toBe(0);
      // 不设 MODELSCOPE_EDIT_MODEL 也不用 msEnv 给的 MODELSCOPE_IMAGE_MODEL：内置默认就是 Edit
      expect(bodyOf(mock.requests[0])).toEqual({
        model: EDIT,
        prompt: "把外套换成红色",
        size: "2048x2048",
      });
      expect(dataOf(r)).toMatchObject({ model: EDIT, size: "2048x2048" });
      expect((await readFile(file("default.png"))).length).toBeGreaterThan(0);
      expect(mock.requests).toHaveLength(1);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("本地文件当参考图：请求体里是 data:image/png;base64, 且字节就是原文件", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await edit(mock, [
        "--prompt",
        "保持五官与服装，只把背景换成海边日落",
        "--ref",
        file("ref.png"),
        "--output",
        file("local.png"),
      ]);
      expect(r.code).toBe(0);
      const body = bodyOf(mock.requests[0]);
      // 实测网关：单张传字符串形态即可
      expect(typeof body.image_url).toBe("string");
      expect(String(body.image_url)).toMatch(/^data:image\/png;base64,/);
      const base64 = String(body.image_url).split(",")[1] as string;
      expect(Buffer.from(base64, "base64").equals(REF_BYTES)).toBe(true);
      const data = dataOf(r);
      expect(data.refCount).toBe(1);
      // 摘要形态：mime + 解码字节数，没有原文
      expect(String(data.refUrls)).toContain("data:image/png;base64,");
      expect(JSON.stringify(data.refUrls)).not.toMatch(BASE64_RUN);
      expect(r.stdout).not.toMatch(BASE64_RUN);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("公网 URL 原样透传（与 gen/fast 同语义），data.refUrls 不摘要", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await edit(mock, ["--prompt", "x", "--ref", URL_A, "--output", file("url.png")]);
      expect(r.code).toBe(0);
      expect(bodyOf(mock.requests[0]).image_url).toBe(URL_A);
      expect(dataOf(r)).toMatchObject({ refUrls: [URL_A], refCount: 1 });
    } finally {
      await mock.close();
    }
  });

  it("上限 4 张（实测硬拦）：4 张混传本地与 URL 走数组形态且顺序保持", async () => {
    const mock = await startMock(refStub);
    try {
      const refs = [file("ref.png"), URL_A, file("ref2.jpg"), URL_B];
      const r = await edit(mock, ["--prompt", "x", "--ref", ...refs, "--output", file("four.png")]);
      expect(r.code).toBe(0);
      const sent = bodyOf(mock.requests[0]).image_url as string[];
      expect(sent).toHaveLength(4);
      expect(sent[0]).toMatch(/^data:image\/png;base64,/);
      expect(sent[1]).toBe(URL_A);
      expect(sent[2]).toMatch(/^data:image\/jpeg;base64,/);
      expect(sent[3]).toBe(URL_B);
      const data = dataOf(r);
      expect(data.refCount).toBe(4);
      const echoed = JSON.stringify(data.refUrls);
      expect(echoed).toContain(URL_A);
      expect(echoed).toContain("data:image/png;base64,");
      expect(echoed).not.toMatch(BASE64_RUN);
    } finally {
      await mock.close();
    }
  });

  it("第 5 张参考图本地即拒：E_INVALID_OPTION 且一次网络都不发", async () => {
    const mock = await startMock(refStub);
    try {
      const five = [URL_A, URL_B, file("ref.png"), file("ref2.jpg"), URL_A];
      const r = await edit(mock, ["--prompt", "x", "--ref", ...five]);
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--ref", value: 5, max: 4 });
      // 文案带上网关原文，调用方能核对是同一个限制
      expect(err.message).toContain("最多 4 张");
      expect(err.message).toContain("exceeds maximum limit of 4");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("prompt 4001 字符本地预检（与 gen/fast 同规则）：0 请求", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await edit(mock, ["--prompt", "a".repeat(4001)]);
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--prompt", limit: 4000, actual: 4001 });
      expect(mock.requests).toHaveLength(0);

      // 4000 个汉字（=12000 字节）按字符计仍可过
      const ok = await edit(mock, ["--prompt", "苹".repeat(4000), "--output", file("cjk.png")]);
      expect(ok.code).toBe(0);
      expect(String(bodyOf(mock.requests[0]).prompt)).toHaveLength(4000);
    } finally {
      await mock.close();
    }
  });

  it("尺寸本地预检：每边 [64,2048]，2049x2049 与星号格式都是 0 请求", async () => {
    const mock = await startMock(refStub);
    try {
      for (const size of ["2049x2049", "2048x2049", "63x1024", "1024*1024", "1024"]) {
        const r = await edit(mock, ["--prompt", "x", "--size", size]);
        expect(r.code).toBe(2);
        expect(parseError(r).code).toBe("E_INVALID_OPTION");
        expect(parseError(r).details?.option).toBe("--size");
      }
      expect(mock.requests).toHaveLength(0);

      // 边界内放行：2048x2048 实测真出 2048x2048（这里只验请求体与 data 契约）
      const max = await edit(mock, [
        "--prompt",
        "x",
        "--size",
        "2048x2048",
        "--output",
        file("m.png"),
      ]);
      expect(max.code).toBe(0);
      expect(bodyOf(mock.requests[0]).size).toBe("2048x2048");
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("steps 收紧到 50（drive-by 回归）：80 与 51 本地拒，50 才发请求", async () => {
    const mock = await startMock(refStub);
    try {
      for (const steps of ["80", "51", "0", "abc"]) {
        const r = await edit(mock, ["--prompt", "x", "--steps", steps]);
        expect(r.code).toBe(2);
        const err = parseError(r);
        expect(err.code).toBe("E_INVALID_OPTION");
        expect(err.details).toMatchObject({ option: "--steps", value: steps });
        expect(err.message).toContain("50");
      }
      expect(mock.requests).toHaveLength(0);

      const ok = await edit(mock, ["--prompt", "x", "--steps", "50", "--output", file("s50.png")]);
      expect(ok.code).toBe(0);
      expect(bodyOf(mock.requests[0]).steps).toBe(50);

      // gen/fast 也走同一条收紧后的校验（网关对 2.1 同样只收 [1,50]）
      const genRun = await gen(mock, ["--prompt", "x", "--steps", "80"]);
      expect(genRun.code).toBe(2);
      expect(parseError(genRun).details?.option).toBe("--steps");
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("guidance 实测区间 [1.0,20.0]：0.9 与 20.5 本地拒，1 与 20 放行", async () => {
    const mock = await startMock(refStub);
    try {
      for (const value of ["0.9", "20.5"]) {
        const r = await edit(mock, ["--prompt", "x", "--guidance", value]);
        expect(r.code).toBe(2);
        expect(parseError(r).details?.option).toBe("--guidance");
      }
      expect(mock.requests).toHaveLength(0);
      for (const [value, name] of [
        ["1", "g1.png"],
        ["20", "g20.png"],
      ] as const) {
        const r = await edit(mock, ["--prompt", "x", "--guidance", value, "--output", file(name)]);
        expect(r.code).toBe(0);
        expect(lastBody(mock).guidance).toBe(Number(value));
      }
    } finally {
      await mock.close();
    }
  });

  it("不传 --ref 也能提交（实测退化为文生图）：请求体里没有 image_url", async () => {
    const mock = await startMock(refStub);
    try {
      const r = await edit(mock, ["--prompt", "一只红苹果", "--output", file("t2i.png")]);
      expect(r.code).toBe(0);
      expect("image_url" in bodyOf(mock.requests[0])).toBe(false);
      expect(dataOf(r).refCount).toBeUndefined();
      expect(dataOf(r).refUrls).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it("坏参考图本地就拒（0 请求）：缺文件 / 未实测扩展名 / 非 http 协议 / 直传 data URI", async () => {
    const mock = await startMock(refStub);
    try {
      const cases: [string[], string][] = [
        [[file("missing.png")], "E_MISSING_ARGUMENT"],
        [[path.join(dir, "nope")], "E_MISSING_ARGUMENT"],
        [[file("notes.txt")], "E_INVALID_OPTION"],
        [["ftp://cdn/a.png"], "E_INVALID_OPTION"],
        [["file:///tmp/a.png"], "E_INVALID_OPTION"],
        [["data:image/png;base64,AAAA"], "E_INVALID_OPTION"],
      ];
      for (const [refs, code] of cases) {
        const r = await edit(mock, ["--prompt", "x", "--ref", ...refs]);
        expect(r.code).toBe(2);
        expect(parseError(r).code).toBe(code);
        expect(parseError(r).details?.option).toBe("--ref");
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("MODELSCOPE_EDIT_MODEL 覆盖内置默认，--model 再覆盖 env，且都不影响 gen", async () => {
    const mock = await startMock(refStub);
    const env: Env = { MODELSCOPE_EDIT_MODEL: "Custom/Image-Edit" };
    try {
      const byEnv = await edit(mock, ["--prompt", "x", "--output", file("e1.png")], env);
      expect(byEnv.code).toBe(0);
      expect(bodyOf(mock.requests[0]).model).toBe("Custom/Image-Edit");

      const byFlag = await edit(
        mock,
        ["--prompt", "x", "--model", "Flag/Edit", "--output", file("e2.png")],
        env,
      );
      expect(byFlag.code).toBe(0);
      expect(bodyOf(mock.requests[1]).model).toBe("Flag/Edit");

      // 模型变量互不串门：gen 仍只认 MODELSCOPE_IMAGE_MODEL
      const genRun = await gen(mock, ["--prompt", "x", "--output", file("e3.png")], env);
      expect(genRun.code).toBe(0);
      expect(bodyOf(mock.requests[2]).model).toBe(BASE_MODEL);
    } finally {
      await mock.close();
    }
  });

  it("异步任务链路复用兄弟命令的实现：轮询用同一把 key，下载结果不带 apikey，默认名前缀 modelscope-edit-", async () => {
    const mock = await startMock((req, endpoint) =>
      req.path === "/v1/images/generations"
        ? { status: 200, body: { task_status: "PENDING", task_id: "edit-task" } }
        : req.path === "/v1/tasks/edit-task"
          ? {
              status: 200,
              body: { task_status: "SUCCEED", output_images: [`${endpoint}/edit.png`] },
            }
          : { status: 200, body: "PNG" },
    );
    try {
      const outDir = file("default-out");
      await mkdir(outDir, { recursive: true });
      // 不传 --output：默认文件名走 edit 的前缀；本地参考图同样能走完提交-轮询-下载
      const r = await edit(mock, ["--prompt", "x", "--ref", file("ref.png")], undefined, outDir);
      expect(r.code).toBe(0);
      const data = dataOf(r);
      expect(data.taskId).toBe("edit-task");
      expect(String(data.sourceUrl)).toContain("/edit.png");
      expect(path.basename(String(data.path))).toMatch(/^modelscope-edit-.+\.png$/);
      expect(path.dirname(String(data.path))).toBe(await realpath(outDir));
      expect((await readFile(String(data.path))).length).toBeGreaterThan(0);
      const taskReq = mock.requests.find((q) => q.path === "/v1/tasks/edit-task");
      expect(taskReq?.key).toBe(KEY);
      const imageReq = mock.requests.find((q) => q.path === "/edit.png");
      expect(imageReq?.key).toBe("");
      expect(r.stdout + r.stderr).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it("真实像素与请求不符 → E_SIZE_MISMATCH 警告（沿用兄弟命令的口径）", async () => {
    const mock = await startMock(() => ({
      status: 200,
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    try {
      const r = await edit(mock, ["--prompt", "x", "--output", file("mismatch.png")]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { size: string };
        warnings: { code: string }[];
      };
      expect(parsed.data.size).toBe("8x16");
      expect(parsed.warnings.map((w) => w.code)).toContain("E_SIZE_MISMATCH");
    } finally {
      await mock.close();
    }
  });

  it("缺 --prompt 是 E_MISSING_ARGUMENT（非交互，绝不挂起），且 --ratio 未声明", async () => {
    const mock = await startMock(refStub);
    try {
      const missing = await edit(mock, []);
      expect(missing.code).toBe(2);
      expect(parseError(missing).code).toBe("E_MISSING_ARGUMENT");

      // edit 刻意不接 --ratio：编辑要跟参考图保持构图，尺寸只由 --size 显式给
      const ratio = await edit(mock, ["--prompt", "x", "--ratio", "16:9"]);
      expect(ratio.code).toBe(2);
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});
