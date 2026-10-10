import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./helpers/cli.js";
import { ffmpegBin, hasFfmpeg } from "./helpers/ffmpeg.js";

const execFileAsync = promisify(execFile);

interface Reply {
  status: number;
  body: string;
}

interface Mock {
  endpoint: string;
  hits: number;
  bodies: string[];
  auths: string[];
  close: () => Promise<void>;
}

// Ark mock：按调用次序回放，便于断言分段顺序、重试次数与请求体
function startMock(replies: Reply[]): Promise<Mock> {
  return new Promise((resolve) => {
    const state = { hits: 0, bodies: [] as string[], auths: [] as string[] };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        state.bodies.push(Buffer.concat(chunks).toString("utf8"));
        state.auths.push(String(req.headers.authorization ?? ""));
        const reply = replies[Math.min(state.hits, replies.length - 1)];
        state.hits += 1;
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        get hits() {
          return state.hits;
        },
        bodies: state.bodies,
        auths: state.auths,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function okReply(text: string): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { audio_tokens: 38 },
      },
    }),
  };
}

function failReply(status: number): Reply {
  return { status, body: JSON.stringify({ error: { message: `mock-${status}` } }) };
}

function doubaoEnv(endpoint: string, key = "test-key"): Record<string, string> {
  return { DOUBAO_API_KEY: key, DOUBAO_BASE_URL: endpoint };
}

function parse(stdout: string): Record<string, never> {
  return JSON.parse(stdout) as Record<string, never>;
}

const T = 60_000;
describe.runIf(hasFfmpeg)("doubao-media-transcribe e2e", () => {
  let dir = "";
  let short = "";
  let medium = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "doubao-e2e-"));
    short = path.join(dir, "short.wav");
    medium = path.join(dir, "medium.wav");
    for (const [file, sec] of [
      [short, 6],
      [medium, 30],
    ] as const) {
      await execFileAsync(ffmpegBin(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${sec}`,
        "-ar",
        "16000",
        "-ac",
        "1",
        file,
      ]);
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "短音频单段：请求体带 base64 input_audio，SRT 落盘且契约字段齐备",
    async () => {
      const mock = await startMock([okReply("第一句\n第二句")]);
      const out = path.join(dir, "a.srt");
      const run = await cli(
        ["--json", "doubao-media-transcribe", "--input", short, "--output", out],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(0);
      const body = parse(run.stdout);
      expect(body).toEqual({
        ok: true,
        data: {
          path: out,
          format: "srt",
          model: "doubao-seed-2-0-mini-260428",
          durationSec: 6,
          segments: 1,
          cues: 2,
          language: "auto",
          bytes: (await readFile(out)).length,
          tokens: { promptTokens: 100, completionTokens: 20, audioTokens: 38 },
        },
        warnings: [],
      });

      const srt = await readFile(out, "utf8");
      expect(srt).toContain("1\n00:00:00,000 --> 00:00:03,000\n第一句");
      expect(srt).toContain("2\n00:00:03,000 --> 00:00:06,000\n第二句");

      const request = JSON.parse(mock.bodies[0]) as {
        model: string;
        messages: { content: { type: string; input_audio?: { format: string } }[] }[];
      };
      expect(request.model).toBe("doubao-seed-2-0-mini-260428");
      expect(request.messages[0].content.map((p) => p.type)).toEqual(["input_audio", "text"]);
      expect(request.messages[0].content[0].input_audio?.format).toBe("mp3");
      expect(mock.auths[0]).toBe("Bearer test-key");
      await mock.close();
    },
    T,
  );

  it(
    "--segment-seconds 切段：串行时段序即时间序，段内按字数摊时间并提示近似",
    async () => {
      const mock = await startMock([okReply("甲段首句\n甲段次句"), okReply("乙段单句")]);
      const out = path.join(dir, "b.srt");
      const run = await cli(
        [
          "--json",
          "doubao-media-transcribe",
          "--input",
          medium,
          "--output",
          out,
          "--segment-seconds",
          "10",
          "--concurrency",
          "1",
        ],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(0);
      const payload = parse(run.stdout) as {
        data: Record<string, number>;
        warnings: { code: string }[];
      };
      expect({ segments: payload.data.segments, cues: payload.data.cues }).toEqual({
        segments: 2,
        cues: 3,
      });
      expect(mock.hits).toBe(2);
      expect(payload.warnings[0]?.code).toBe("E_TIMELINE_APPROXIMATE");

      const srt = await readFile(out, "utf8");
      const lines = srt.split(/\r?\n/).filter((l) => l && !/^\d+$/.test(l) && !l.includes("-->"));
      expect(lines).toEqual(["甲段首句", "甲段次句", "乙段单句"]);
      expect(srt).toContain("00:00:15,000 --> 00:00:30,000");
      await mock.close();
    },
    T,
  );

  it(
    "默认并发下分段结果仍按段索引归位，时间轴连续覆盖全片",
    async () => {
      const mock = await startMock([okReply("同一句")]);
      const out = path.join(dir, "d.srt");
      const run = await cli(
        [
          "--json",
          "doubao-media-transcribe",
          "--input",
          medium,
          "--output",
          out,
          "--segment-seconds",
          "10",
        ],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(0);
      expect(mock.hits).toBe(2);
      // 两段的音频负载必须不同（确实切成了两段），且时间轴从 0 覆盖到结尾
      expect(mock.bodies[0]).not.toBe(mock.bodies[1]);
      const srt = await readFile(out, "utf8");
      expect(srt).toContain("1\n00:00:00,000 --> 00:00:15,000");
      expect(srt).toContain("2\n00:00:15,000 --> 00:00:30,000");
      await mock.close();
    },
    T,
  );

  it(
    "--format txt 输出纯文本、无字幕序号",
    async () => {
      const mock = await startMock([okReply("一行\n两行")]);
      const out = path.join(dir, "c.txt");
      const run = await cli(
        ["--json", "doubao-media-transcribe", "--input", short, "--output", out, "--format", "txt"],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(0);
      expect((await readFile(out, "utf8")).trim()).toBe("一行\n两行");
      const data = (parse(run.stdout) as { data: Record<string, unknown> }).data;
      expect(data).not.toHaveProperty("cues");
      await mock.close();
    },
    T,
  );

  it(
    "401 立即失败（不重试）→ E_CONFIG；429 两次后成功（重试生效）",
    async () => {
      const denied = await startMock([failReply(401)]);
      const bad = await cli(
        ["--json", "doubao-media-transcribe", "--input", short],
        doubaoEnv(denied.endpoint),
      );
      expect(bad.code).toBe(3);
      expect((parse(bad.stdout) as { error: { code: string } }).error.code).toBe("E_CONFIG");
      expect(denied.hits).toBe(1);
      await denied.close();

      const flaky = await startMock([failReply(429), failReply(503), okReply("恢复")]);
      const ok = await cli(
        ["--json", "doubao-media-transcribe", "--input", short],
        doubaoEnv(flaky.endpoint),
      );
      expect(ok.code).toBe(0);
      expect(flaky.hits).toBe(3);
      expect(await readFile(`${short}.srt`, "utf8")).toContain("恢复");
      await flaky.close();
    },
    T,
  );

  it(
    "400 不重试 → E_PROVIDER_ERROR 且带响应体；空内容 → empty_result",
    async () => {
      const mock = await startMock([failReply(400)]);
      const run = await cli(
        ["--json", "doubao-media-transcribe", "--input", short],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(3);
      const error = (parse(run.stdout) as { error: { code: string; details: { status: number } } })
        .error;
      expect(error.code).toBe("E_PROVIDER_ERROR");
      expect(error.details.status).toBe(400);
      expect(mock.hits).toBe(1);
      await mock.close();

      const empty = await startMock([{ status: 200, body: '{"choices":[]}' }]);
      const run2 = await cli(
        ["--json", "doubao-media-transcribe", "--input", short],
        doubaoEnv(empty.endpoint),
      );
      expect(run2.code).toBe(3);
      expect(
        (parse(run2.stdout) as { error: { details: { reason: string } } }).error.details.reason,
      ).toBe("empty_result");
      await empty.close();
    },
    T,
  );

  it(
    "用法与配置错误本地收敛：缺 key / 缺 input / 输入不存在 / --format 非法都不发请求",
    async () => {
      const mock = await startMock([okReply("never")]);
      const noKey = await cli(["--json", "doubao-media-transcribe", "--input", short], {
        DOUBAO_API_KEY: "",
        DOUBAO_BASE_URL: mock.endpoint,
      });
      expect(noKey.code).toBe(3);
      expect((parse(noKey.stdout) as { error: { code: string } }).error.code).toBe("E_CONFIG");

      const noInput = await cli(["--json", "doubao-media-transcribe"], doubaoEnv(mock.endpoint));
      expect(noInput.code).toBe(2);
      expect((parse(noInput.stdout) as { error: { code: string } }).error.code).toBe(
        "E_MISSING_ARGUMENT",
      );

      const missing = await cli(
        ["--json", "doubao-media-transcribe", "--input", path.join(dir, "nope.wav")],
        doubaoEnv(mock.endpoint),
      );
      expect(missing.code).toBe(2);

      const badFormat = await cli(
        ["--json", "doubao-media-transcribe", "--input", short, "--format", "vtt"],
        doubaoEnv(mock.endpoint),
      );
      expect(badFormat.code).toBe(2);
      expect((parse(badFormat.stdout) as { error: { code: string } }).error.code).toBe(
        "E_INVALID_OPTION",
      );
      expect(mock.hits).toBe(0);
      await mock.close();
    },
    T,
  );

  it(
    "spec 输出包含 doubao-media-transcribe 的全部选项",
    async () => {
      const run = await cli(["--json", "spec"]);
      expect(run.code).toBe(0);
      const spec = parse(run.stdout) as {
        data: { commands: { name: string; options?: { flags: string }[] }[] };
      };
      const cmd = spec.data.commands.find((c) => c.name === "doubao-media-transcribe");
      expect(cmd?.options?.map((o) => o.flags)).toEqual([
        "--input <path>",
        "--output <path>",
        "--format <format>",
        "--model <id>",
        "--language <code>",
        "--prompt <text>",
        "--segment-seconds <n>",
        "--concurrency <n>",
      ]);
    },
    T,
  );
});
