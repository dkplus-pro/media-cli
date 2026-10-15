import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type CliRun, cli } from "./helpers/cli";

// spawn 真进程的 e2e：全量并发时单条会超过 vitest 默认 5s（实测 F7 字号用例在满载下超时），
// 故整文件设 30s 上限，与仓库既有慢用例显式 `, 30000)` 的口径一致。
vi.setConfig({ testTimeout: 30_000 });

// doubao-grid-locate 的 e2e 全部打本地 Ark mock：本机 ~/.zshrc 里有真 DOUBAO_API_KEY，
// 所以每个用例都显式覆盖成假 key（helpers/cli.ts 的 undefined = 从继承环境里删）。
// 契约重点：cells JSON 与 media-grid-caption --cells 完全对接（D30）、缺模型不碰网络、
// 视觉模型两次不吐合法 JSON 才失败且带截断原文。

interface MockRequest {
  method: string;
  body: string;
  auth: string;
  path: string;
}

interface Mock {
  endpoint: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

interface Envelope {
  ok: boolean;
  data: {
    cells: { index: number; x: number; y: number; w: number; h: number }[];
    image: { width: number; height: number };
    source: string;
    model: string;
    notes?: string[];
    path?: string;
    bytes?: number;
    scale?: number;
    maxSide?: number;
    timeoutMs?: number;
    overlapRepaired?: number;
    sent?: {
      maxSide: number;
      width: number;
      height: number;
      sx: number;
      sy: number;
      encode?: string;
      quality?: number;
    };
    expected?: number;
  };
  warnings: { code: string; message: string }[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface Run extends CliRun {
  j: Envelope;
}

const FAKE_KEY = "ark-test-secret-key-never-leak";
const MODEL = "mock-vision-model-260915";
// 4 格 64x64 图（每格 32x32）——与 mock 回的坐标同一坐标系
const CELLS = JSON.stringify({
  cells: [
    { index: 0, x: 0, y: 0, w: 32, h: 32 },
    { index: 1, x: 32, y: 0, w: 32, h: 32 },
    { index: 2, x: 0, y: 32, w: 32, h: 32 },
    { index: 3, x: 32, y: 32, w: 32, h: 32 },
  ],
  image: { width: 64, height: 64 },
  source: "vision",
});

function reply(content: string) {
  return JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

// 按调用次序回放（超出条数后重复最后一条），便于断言「重试了一次」。
// delayMs 用来演「provider 就是要很久」——Issue 3 的超时用例靠它，不靠真网络。
async function startMock(
  contents: string[],
  { delayMs = 0 }: { delayMs?: number } = {},
): Promise<Mock> {
  const requests: MockRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        auth: String(req.headers.authorization ?? ""),
      });
      const content = contents[Math.min(requests.length - 1, contents.length - 1)];
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(reply(content));
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function env(endpoint: string, extra: Record<string, string | undefined> = {}) {
  return {
    DOUBAO_API_KEY: FAKE_KEY,
    DOUBAO_BASE_URL: endpoint,
    DOUBAO_VISION_MODEL: MODEL,
    // 转写模型与本命令无关，删掉避免本机真值串味
    DOUBAO_TRANSCRIBE_MODEL: undefined,
    ...extra,
  };
}

let dir = "";
let png = "";
let wide = ""; // 2048x1024：--max-side 1568 下会被缩到 1568x784（scale=0.765625）
let photo = ""; // 2048x2048 噪声 jpeg：原图 base64 很大，用来证明请求体真的瘦身了
let page = ""; // 2048x2048 RGBA png 分镜页（真实产物的形态：带 alpha，PNG 体积极大）

// 伪随机噪声（固定种子，避免用例间抖动）：让 jpeg 压不动，模拟真实分镜页的体积
function noiseBuffer(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3);
  let state = 20261014;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    raw[i] = state & 0xff;
  }
  return raw;
}

// 分镜页形状的 RGBA 数据：色块 + 深色格线 + 少量颗粒（PNG 很大、JPEG 压得动，与真实页同形）
function storyboardRgba(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 4);
  let state = 77777;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      state = (state * 1103515245 + 12345) % 2147483648;
      const cell = (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2);
      const base = [60, 150, 90, 180][cell];
      const gutter = x % 512 < 4 || y % 512 < 4;
      const ink = gutter ? 12 : Math.min(255, base + (state % 40) - 20);
      raw[i] = ink;
      raw[i + 1] = ink;
      raw[i + 2] = ink;
      raw[i + 3] = x % 640 < 6 ? 0 : 255; // 一条透明带：证明 alpha 被压白底而不是丢通道
    }
  }
  return raw;
}

async function run(
  args: string[],
  endpoint: string,
  extra: Record<string, string | undefined> = {},
): Promise<Run> {
  const r = await cli(["--json", "doubao-grid-locate", ...args], env(endpoint, extra));
  return { ...r, j: JSON.parse(r.stdout) as Envelope };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "doubao-grid-locate-e2e-"));
  png = path.join(dir, "grid.png");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } })
    .png()
    .toFile(png);
  wide = path.join(dir, "wide.png");
  await sharp({ create: { width: 2048, height: 1024, channels: 3, background: "#808080" } })
    .png()
    .toFile(wide);
  photo = path.join(dir, "photo.jpg");
  await sharp(noiseBuffer(2048, 2048), { raw: { width: 2048, height: 2048, channels: 3 } })
    .jpeg({ quality: 80 })
    .toFile(photo);
  page = path.join(dir, "page.png");
  await sharp(storyboardRgba(2048, 2048), { raw: { width: 2048, height: 2048, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(page);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("doubao-grid-locate e2e", () => {
  it("带 ```json 围栏的输出照样解析成功，data 就是 §2 的 cells schema", async () => {
    const mock = await startMock([`好的：\n\`\`\`json\n${CELLS}\n\`\`\``]);
    const r = await run(["--input", png], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data).toMatchObject({
      source: "vision",
      model: MODEL,
      image: { width: 64, height: 64 },
    });
    expect(r.j.data.cells).toHaveLength(4);
    expect(r.j.data.cells[3]).toEqual({ index: 3, x: 32, y: 32, w: 32, h: 32 });
    expect(mock.requests).toHaveLength(1);
    await mock.close();
  });

  it("第一次不是合法 JSON → 追加更严指令重试一次并成功", async () => {
    const mock = await startMock(["我认为这张图有 4 格，坐标大概是 0,0,32,32 …", CELLS]);
    const r = await run(["--input", png], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.cells).toHaveLength(4);
    expect(mock.requests).toHaveLength(2);
    // 第二次的 prompt 带上了「只输出 JSON」的硬要求
    expect(mock.requests[1].body).toContain("只输出一个 JSON 对象");
    await mock.close();
  });

  it("两次都不是 JSON → E_PROVIDER_ERROR + reason=unparsable_vision_output + 截断原文", async () => {
    const mock = await startMock(["抱歉，我无法输出 JSON。".repeat(80)]);
    const r = await run(["--input", png], mock.endpoint);
    expect(r.code).toBe(3);
    expect(r.j.ok).toBe(false);
    expect(r.j.error?.code).toBe("E_PROVIDER_ERROR");
    expect(r.j.error?.details).toMatchObject({ reason: "unparsable_vision_output" });
    expect(String(r.j.error?.details?.raw)).toHaveLength(800);
    expect(mock.requests).toHaveLength(2);
    await mock.close();
  });

  it("缺 DOUBAO_VISION_MODEL 且没传 --model → E_CONFIG 且完全不碰网络", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", png], mock.endpoint, { DOUBAO_VISION_MODEL: undefined });
    expect(r.code).toBe(3);
    expect(r.j.error?.code).toBe("E_CONFIG");
    expect(r.j.error?.details).toMatchObject({ var: "DOUBAO_VISION_MODEL" });
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("--model 覆盖环境变量里的默认视觉模型", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", png, "--model", "explicit-vision-id"], mock.endpoint);
    expect(r.j.data.model).toBe("explicit-vision-id");
    expect(JSON.parse(mock.requests[0].body).model).toBe("explicit-vision-id");
    await mock.close();
  });

  it("--input 是目录 → E_INVALID_OPTION（本命令只做单图）", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", dir], mock.endpoint);
    expect(r.code).toBe(2);
    expect(r.j.error?.code).toBe("E_INVALID_OPTION");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("请求体把图作为 data:image/ 的 image_url 送进 messages[0].content", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", png, "--expected", "4"], mock.endpoint);
    expect(r.code).toBe(0);
    const body = JSON.parse(mock.requests[0].body) as {
      messages: {
        role: string;
        content: { type: string; image_url?: { url: string }; text?: string }[];
      }[];
    };
    const parts = body.messages[0].content;
    expect(body.messages[0].role).toBe("user");
    expect(parts.map((p) => p.type)).toEqual(["image_url", "text"]);
    expect(parts[0].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(parts[1].text).toContain("像素");
    expect(parts[1].text).toContain("64x64"); // 本地解出的真实尺寸写进 prompt
    expect(parts[1].text).toContain("4 格"); // --expected 生效
    await mock.close();
  });

  it("模型给归一化坐标 → 自动放大成像素并在 data.notes 里说明", async () => {
    const normalized = JSON.stringify({
      cells: [
        { index: 0, x: 0, y: 0, w: 0.5, h: 0.5 },
        { index: 1, x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      ],
      image: { width: 1, height: 1 },
      source: "vision",
    });
    const mock = await startMock([normalized]);
    const r = await run(["--input", png], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.image).toEqual({ width: 64, height: 64 });
    expect(r.j.data.cells[0]).toMatchObject({ x: 0, y: 0, w: 32, h: 32 });
    expect((r.j.data.notes ?? []).join(" ")).toContain("归一化");
    await mock.close();
  });

  it("--output 落盘的 cells 文件可直接喂 media-grid-caption --cells", async () => {
    const mock = await startMock([CELLS]);
    const cellsFile = path.join(dir, "cells.json");
    const r = await run(["--input", png, "--output", cellsFile], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.path).toBe(cellsFile);
    const written = JSON.parse(await readFile(cellsFile, "utf8")) as Envelope["data"];
    expect(written).toMatchObject({ source: "vision", image: { width: 64, height: 64 } });
    await mock.close();

    const captions = path.join(dir, "caps.json");
    await writeFile(captions, JSON.stringify([{ index: 0, text: "对接成功" }]));
    const out = path.join(dir, "captioned.png");
    const cap = await cli(
      [
        "--json",
        "media-grid-caption",
        "--input",
        png,
        "--cells",
        cellsFile,
        "--captions",
        captions,
        "--output",
        out,
      ],
      {},
    );
    const parsed = JSON.parse(cap.stdout) as {
      ok: boolean;
      data: { source: string; cells: number };
    };
    expect(cap.code).toBe(0);
    expect(parsed.data).toMatchObject({ source: "vision", cells: 4 });
    expect((await sharp(out).metadata()).width).toBe(64);
  });

  it("F1：图先缩到 --max-side 以内再送模型，坐标一律放大回原图像素（§2 口径）", async () => {
    // 2048x1024 → 送出 1568x784（scale=0.765625）。模型看到的就是那张小图，
    // 所以它给的 x=784 是**小图**的正中；输出必须是原图的 1024。
    const inSentSpace = JSON.stringify({
      cells: [
        { index: 0, x: 0, y: 0, w: 784, h: 784 },
        { index: 1, x: 784, y: 0, w: 784, h: 784 },
      ],
      image: { width: 1568, height: 784 },
      source: "vision",
    });
    const mock = await startMock([inSentSpace]);
    const r = await run(["--input", wide], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.image).toEqual({ width: 2048, height: 1024 });
    expect(r.j.data.scale).toBe(0.765625);
    expect(r.j.data.maxSide).toBe(1568);
    expect(r.j.data.sent).toMatchObject({ maxSide: 1568, width: 1568, height: 784 });
    expect(r.j.data.cells?.[0]).toEqual({ index: 0, x: 0, y: 0, w: 1024, h: 1024 });
    expect(r.j.data.cells?.[1]).toEqual({ index: 1, x: 1024, y: 0, w: 1024, h: 1024 });
    // 784 / 0.765625 = 1024：越界一格都没有（放大后仍贴在原图画布内）
    for (const cell of r.j.data.cells ?? []) {
      expect(cell.x + cell.w).toBeLessThanOrEqual(2048);
      expect(cell.y + cell.h).toBeLessThanOrEqual(1024);
    }
    expect((r.j.data.notes ?? []).join(" ")).toContain("放大回原图");
    const body = JSON.parse(mock.requests[0].body) as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    const text = body.messages[0].content[1].text ?? "";
    expect(text).toContain("1568x784"); // 告诉模型它看到的是缩小图
    expect(text).toContain("缩小");
    await mock.close();
  });

  it("F1：请求体显著小于「原图直接 base64」的体积（实测超时的根因）", async () => {
    const originalBase64 = (await readFile(photo)).toString("base64").length;
    const cellsInSentSpace = JSON.stringify({
      cells: [{ index: 0, x: 0, y: 0, w: 1568, h: 1568 }],
      image: { width: 1568, height: 1568 },
      source: "vision",
    });
    const mock = await startMock([cellsInSentSpace]);
    const r = await run(["--input", photo], mock.endpoint);
    expect(r.code).toBe(0);
    const sentBytes = Buffer.byteLength(mock.requests[0].body);
    expect(sentBytes).toBeLessThan(Math.floor(originalBase64 * 0.9));
    expect(r.j.data.image).toEqual({ width: 2048, height: 2048 });
    expect(r.j.data.cells?.[0]).toMatchObject({ x: 0, y: 0, w: 2048, h: 2048 });
    await mock.close();
  });

  it("--max-side 越界即拒（不碰网络）；图本来就够小则原图直送 scale=1", async () => {
    const mock = await startMock([CELLS]);
    const tooSmall = await run(["--input", png, "--max-side", "64"], mock.endpoint);
    expect(tooSmall.code).toBe(2);
    expect(tooSmall.j.error?.code).toBe("E_INVALID_OPTION");
    expect(tooSmall.j.error?.details).toMatchObject({ option: "--max-side" });
    expect((await run(["--input", png, "--max-side", "abc"], mock.endpoint)).j.error?.code).toBe(
      "E_INVALID_OPTION",
    );
    expect(mock.requests).toHaveLength(0);
    await mock.close();

    // 长边本来就在 --max-side 以内 → 原图直送，坐标一格都不该被换算过
    const passthrough = JSON.stringify({
      cells: [
        { index: 0, x: 0, y: 0, w: 1024, h: 512 },
        { index: 1, x: 1024, y: 512, w: 1024, h: 512 },
      ],
      image: { width: 2048, height: 1024 },
      source: "vision",
    });
    const mock2 = await startMock([passthrough]);
    const bigEnough = await run(["--input", wide, "--max-side", "2048"], mock2.endpoint);
    expect(bigEnough.j.data).toMatchObject({ scale: 1, maxSide: 2048 });
    expect(bigEnough.j.data.sent).toBeUndefined();
    expect(bigEnough.j.data.image).toEqual({ width: 2048, height: 1024 });
    expect(bigEnough.j.data.cells).toEqual([
      { index: 0, x: 0, y: 0, w: 1024, h: 512 },
      { index: 1, x: 1024, y: 512, w: 1024, h: 512 },
    ]);
    expect(bigEnough.j.data.notes).toBeUndefined();
    // 默认 1568 下的 64x64 小图同样不缩（老行为不变）
    expect((await run(["--input", png], mock2.endpoint)).j.data.scale).toBe(1);
    await mock2.close();
  });

  it("F4：--expected 与实际检出格数不符 → E_CELL_COUNT_MISMATCH 警告（两个数字都给），命令仍成功", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", png, "--expected", "9"], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.ok).toBe(true);
    const mismatch = r.j.warnings.find((w) => w.code === "E_CELL_COUNT_MISMATCH");
    expect(mismatch?.message).toContain("4 格");
    expect(mismatch?.message).toContain("9");
    expect(r.j.data.expected).toBe(9);
    // 数量对上就不该冒出这条警告
    const matched = await run(["--input", png, "--expected", "4"], mock.endpoint);
    expect(matched.j.warnings.map((w) => w.code)).not.toContain("E_CELL_COUNT_MISMATCH");
    // 没给 --expected 时也绝不产生这条警告
    expect((await run(["--input", png], mock.endpoint)).j.warnings).toEqual([]);
    await mock.close();
  });

  it("任何输出都不出现 key 原文", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", png], mock.endpoint);
    expect(mock.requests[0].auth).toBe(`Bearer ${FAKE_KEY}`); // 确实带上了
    expect(r.stdout + r.stderr).not.toContain(FAKE_KEY);
    await mock.close();
  });

  // ---- Issue 2：瘦身来自「降采样后重编码 JPEG」，不是「保留原格式的无损重编码」 ----
  it("F1 补充：RGBA PNG 送模型前重编码为 JPEG（data URI 的 mime 与字节都变），alpha 压白底并留 note", async () => {
    const originalBase64 = (await readFile(page)).toString("base64").length;
    const mock = await startMock([CELLS]);
    const r = await run(["--input", page], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.sent).toMatchObject({ encode: "jpeg", quality: 82, width: 1568, height: 1568 });
    const body = JSON.parse(mock.requests[0].body) as {
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    const uri = body.messages[0].content[0].image_url?.url ?? "";
    expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    // 旧实现（PNG 无损重编码）只瘦 9.2%；JPEG 要瘦掉一个数量级
    expect(uri.length).toBeLessThan(originalBase64 * 0.25);
    expect((r.j.data.notes ?? []).join(" ")).toContain("透明通道");
    await mock.close();
  });

  // ---- Issue 3：本命令的超时预算要贴住实测（单页 181.8s / 329.6s） ----
  it("默认单次超时 300000（不是转写那套 120000；实测单页 181.8s/329.6s），data.timeoutMs 回显真值", async () => {
    const mock = await startMock([CELLS]);
    const r = await run(["--input", png], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.timeoutMs).toBe(300000);
    await mock.close();
  });

  it("DOUBAO_TIMEOUT_MS 覆盖默认值；--timeout 再覆盖 env（优先级：flag > env > 命令默认）", async () => {
    const mock = await startMock([CELLS]);
    expect(
      (await run(["--input", png], mock.endpoint, { DOUBAO_TIMEOUT_MS: "45000" })).j.data.timeoutMs,
    ).toBe(45000);
    expect(
      (
        await run(["--input", png, "--timeout", "5000"], mock.endpoint, {
          DOUBAO_TIMEOUT_MS: "45000",
        })
      ).j.data.timeoutMs,
    ).toBe(5000);
    await mock.close();
  });

  it("--timeout 真生效：慢 mock + --timeout 1000 → E_PROVIDER_ERROR reason=timeout 且报的是 1000ms", async () => {
    const mock = await startMock([CELLS], { delayMs: 2500 });
    const r = await run(["--input", png, "--timeout", "1000"], mock.endpoint);
    expect(r.code).toBe(3);
    expect(r.j.error?.code).toBe("E_PROVIDER_ERROR");
    expect(r.j.error?.details).toMatchObject({ reason: "timeout" });
    expect(r.j.error?.message).toContain("1000ms");
    expect(mock.requests.length).toBe(3); // 3 次尝试全部 abort，没把慢响应误判成成功
    await mock.close();
  }, 30_000); // 3 次 abort + 400/1200ms 退避 ≈ 4.6s，超过 vitest 默认 5s 的并发余量

  it("--timeout 越界或非数字 → E_INVALID_OPTION 且不碰网络", async () => {
    const mock = await startMock([CELLS]);
    for (const bad of ["0", "-5", "abc", "999", "1800001"]) {
      const r = await run(["--input", png, "--timeout", bad], mock.endpoint);
      expect(r.code).toBe(2);
      expect(r.j.error?.code).toBe("E_INVALID_OPTION");
      expect(r.j.error?.details).toMatchObject({ option: "--timeout" });
    }
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  // ---- Issue 1（产出侧）：放大取整产生的薄条重叠必须在产出的那一侧就切齐 ----
  it("F2：放大回原图产生的 1px 重叠被切齐 → data.overlapRepaired + E_CELL_OVERLAP_REPAIRED 警告，产物直接喂 media-grid-caption 不再被打回", async () => {
    // 送模型的是 1568x784（wide.png 的缩小图）。模型把第 1 格的 x 给成 1023（比公共边偏 1 小图像素），
    // 放大回 2048x1024 后第 0 格右边（1337）就压住了第 1 格左边（1336）——旧行为原样落盘。
    const jittered = JSON.stringify({
      cells: [
        { index: 0, x: 0, y: 0, w: 1024, h: 392 },
        { index: 1, x: 1023, y: 0, w: 545, h: 392 },
      ],
      image: { width: 1568, height: 784 },
      source: "vision",
    });
    const mock = await startMock([jittered]);
    const cellsFile = path.join(dir, "repaired-cells.json");
    const r = await run(["--input", wide, "--output", cellsFile], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.overlapRepaired).toBe(1);
    expect(r.j.warnings.map((w) => w.code)).toContain("E_CELL_OVERLAP_REPAIRED");
    expect((r.j.data.notes ?? []).join(" ")).toContain("切齐");
    // 切完互不重叠、且只在重叠区里动了一格的一条边
    const [c0, c1] = r.j.data.cells;
    expect(c0.x + c0.w).toBeLessThanOrEqual(c1.x);
    expect(c1.x + c1.w).toBeLessThanOrEqual(2048);
    expect(c1.y + c1.h).toBeLessThanOrEqual(1024);
    await mock.close();

    const cap = await cli(
      [
        "--json",
        "media-grid-caption",
        "--input",
        wide,
        "--cells",
        cellsFile,
        "--output",
        path.join(dir, "repaired.png"),
      ],
      {},
    );
    const parsed = JSON.parse(cap.stdout) as {
      ok: boolean;
      data: { cells: number; minorOverlaps: number };
      warnings: { code: string }[];
    };
    expect(cap.code).toBe(0);
    expect(parsed.data).toMatchObject({ cells: 2, minorOverlaps: 0 });
    expect(parsed.warnings.map((w) => w.code)).not.toContain("E_CELLS_OVERLAP");
  });

  it("F2：模型真的把两格框重了（薄边 >5%）→ 不硬修，overlapRepaired:0 并附 E_CELLS_OVERLAP 警告点名", async () => {
    const heavy = JSON.stringify({
      cells: [
        { index: 0, x: 0, y: 0, w: 1024, h: 784 },
        { index: 1, x: 700, y: 0, w: 868, h: 784 }, // 与第 0 格重叠 324x784（薄边 32%）
      ],
      image: { width: 1568, height: 784 },
      source: "vision",
    });
    const mock = await startMock([heavy]);
    const r = await run(["--input", wide], mock.endpoint);
    expect(r.code).toBe(0);
    expect(r.j.data.overlapRepaired).toBe(0);
    const overlap = r.j.warnings.find((w) => w.code === "E_CELLS_OVERLAP");
    expect(overlap?.message).toContain("重叠幅度较大");
    // 警告不许把用户踢回产出这份文件的命令（实测旧文案就是「用 doubao-grid-locate 重跑」）
    expect(overlap?.message).not.toContain("doubao-grid-locate");
    expect(overlap?.message).toContain("--allow-overlap");
    expect(mock.requests).toHaveLength(1);
    await mock.close();
  });
});
