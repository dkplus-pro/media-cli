import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));
const MP3_BYTES = Buffer.from("ID3-MOCK-SUNO-MP3");

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: merged,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

// ---- mock：固定 id 语义表，按键值模拟 401/402 ----

interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: Buffer;
}

interface SunoMock {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function startSunoMock(): Promise<SunoMock> {
  const counters = new Map<number, number>();
  const requests: RecordedRequest[] = [];
  let baseUrl = "";

  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawUrl = req.url ?? "";
      const [pathPart, queryPart = ""] = rawUrl.split("?");
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? "", path: pathPart, query: queryPart, body });
      const auth = req.headers.authorization ?? "";
      const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (key === "bad-key") return respond(401, { error: "unauthorized" });

      if (pathPart === "/api/v1/music/generate" || pathPart === "/api/v1/music/sound") {
        if (key === "broke-key") return respond(402, { error: "insufficient points" });
        const text = body.toString();
        const ids = text.includes("stuck")
          ? [998, 999]
          : pathPart === "/api/v1/music/generate"
            ? [204, 205]
            : [304, 305];
        return respond(200, { data: { task_ids: ids } });
      }

      if (pathPart === "/api/v1/music/task") {
        const id = Number(new URLSearchParams(queryPart).get("id"));
        let status: string;
        if (id === 206) status = "completed";
        else if (id === 207 || id >= 998) status = "pending";
        else {
          const n = (counters.get(id) ?? 0) + 1;
          counters.set(id, n);
          status = n >= 3 ? "completed" : n === 2 ? "processing" : "pending";
        }
        if (status !== "completed") return respond(200, { data: { status, result: {} } });
        return respond(200, {
          data: {
            status,
            result: {
              title: `song-${id}`,
              custom_id: `uuid-${id}`,
              fileInfo: {
                mp3Url: `${baseUrl}/file.mp3?t=${id}`,
                cosUrl: `${baseUrl}/cover.jpg`,
                duration: 123,
              },
            },
          },
        });
      }

      if (pathPart === "/api/v1/points/balance") {
        return respond(200, { data: { remaining_points: 888 } });
      }

      if (pathPart === "/file.mp3") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(MP3_BYTES);
        return;
      }

      respond(404, { error: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("suno-music e2e（本地 mock）", () => {
  let mock: SunoMock;
  let dir: string;
  const BASE_ENV = () => ({
    SUNO_API_KEY: "test-key",
    SUNO_BASE_URL: mock.baseUrl,
    SUNO_POLL_INTERVAL_MS: "10",
    SUNO_TIMEOUT_MS: "10000",
  });

  beforeAll(async () => {
    mock = await startSunoMock();
    dir = await mkdtemp(path.join(tmpdir(), "suno-e2e-"));
  }, 30_000);

  afterAll(async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });

  function taskRequestCount(): number {
    return mock.requests.filter((r) => r.path === "/api/v1/music/task").length;
  }

  it("suno-gen 等待模式：两首落盘，--output 自动 -1/-2 命名", async () => {
    const r = await cli(
      ["--json", "suno-gen", "--prompt", "lo-fi hip hop", "--output", path.join(dir, "x.mp3")],
      BASE_ENV(),
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      data: {
        tracks: {
          taskId: number;
          customId: string;
          durationSec: number;
          path: string;
          bytes: number;
        }[];
        failed: unknown[];
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.tracks).toHaveLength(2);
    expect(parsed.data.failed).toEqual([]);
    expect(parsed.data.tracks[0].customId).toBe("uuid-204");
    expect(parsed.data.tracks[0].durationSec).toBe(123);
    for (const [i, track] of parsed.data.tracks.entries()) {
      expect(track.path).toBe(path.join(dir, `x-${i + 1}.mp3`));
      expect(track.bytes).toBe(MP3_BYTES.length);
      expect((await readFile(track.path)).equals(MP3_BYTES)).toBe(true);
    }
  }, 30_000);

  it("--no-wait：只提交返回 taskIds，不产生任务查询", async () => {
    const before = taskRequestCount();
    const r = await cli(["--json", "suno-gen", "--prompt", "quick", "--no-wait"], BASE_ENV());
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { data: { taskIds: number[] } };
    expect(parsed.data.taskIds).toEqual([204, 205]);
    expect(taskRequestCount()).toBe(before);
  }, 30_000);

  it("suno-sound：请求体走 /music/sound 且不含后端固定字段", async () => {
    const r = await cli(
      [
        "--json",
        "suno-sound",
        "--text",
        "rain on roof",
        "--tags",
        "ambient",
        "--loop",
        "--no-wait",
      ],
      BASE_ENV(),
    );
    expect(r.code).toBe(0);
    const soundReq = mock.requests.find((r2) => r2.path === "/api/v1/music/sound");
    expect(soundReq).toBeTruthy();
    const sent = JSON.parse(soundReq.body.toString()) as Record<string, unknown>;
    expect(sent.title).toBe("rain on roof");
    expect(sent.tags).toBe("ambient");
    expect(sent.loop).toBe(true);
    expect(sent).not.toHaveProperty("make_instrumental");
    expect(sent).not.toHaveProperty("generation_type");
    expect(sent).not.toHaveProperty("task");
  }, 30_000);

  it("suno-task：completed 返回文件字段，pending 不含 audioUrl", async () => {
    const done = await cli(["--json", "suno-task", "--id", "206"], BASE_ENV());
    expect(done.code).toBe(0);
    const doneData = (JSON.parse(done.stdout) as { data: Record<string, unknown> }).data;
    expect(doneData.status).toBe("completed");
    expect(doneData.audioUrl).toContain("/file.mp3");
    expect(doneData.customId).toBe("uuid-206");
    expect(doneData.durationSec).toBe(123);

    const pending = await cli(["--json", "suno-task", "--id", "207"], BASE_ENV());
    expect(pending.code).toBe(0);
    const pendingData = (JSON.parse(pending.stdout) as { data: Record<string, unknown> }).data;
    expect(pendingData.status).toBe("pending");
    expect(pendingData).not.toHaveProperty("audioUrl");
  }, 30_000);

  it("suno-download：completed 落盘；pending 报 E_PROVIDER_ERROR", async () => {
    const out = path.join(dir, "d.mp3");
    const ok = await cli(["--json", "suno-download", "--id", "206", "--output", out], BASE_ENV());
    expect(ok.code).toBe(0);
    const okData = (JSON.parse(ok.stdout) as { data: { path: string; bytes: number } }).data;
    expect(okData.bytes).toBe(MP3_BYTES.length);
    expect((await readFile(out)).equals(MP3_BYTES)).toBe(true);

    const bad = await cli(
      ["--json", "suno-download", "--id", "207", "--output", path.join(dir, "y.mp3")],
      BASE_ENV(),
    );
    expect(bad.code).toBe(3);
    const badErr = (
      JSON.parse(bad.stdout) as { error: { code: string; details: { status: string } } }
    ).error;
    expect(badErr.code).toBe("E_PROVIDER_ERROR");
    expect(badErr.details.status).toBe("pending");
  }, 30_000);

  it("suno-balance：返回 remainingPoints", async () => {
    const r = await cli(["--json", "suno-balance"], BASE_ENV());
    expect(r.code).toBe(0);
    expect(
      (JSON.parse(r.stdout) as { data: { remainingPoints: number } }).data.remainingPoints,
    ).toBe(888);
  }, 30_000);

  it("key 无效 → E_CONFIG；积分不足 → E_PROVIDER_ERROR(insufficient_points)", async () => {
    const unauthorized = await cli(["--json", "suno-balance"], {
      ...BASE_ENV(),
      SUNO_API_KEY: "bad-key",
    });
    expect(unauthorized.code).toBe(3);
    expect((JSON.parse(unauthorized.stdout) as { error: { code: string } }).error.code).toBe(
      "E_CONFIG",
    );

    const broke = await cli(["--json", "suno-gen", "--prompt", "x", "--no-wait"], {
      ...BASE_ENV(),
      SUNO_API_KEY: "broke-key",
    });
    expect(broke.code).toBe(3);
    const brokeErr = (
      JSON.parse(broke.stdout) as { error: { code: string; details: { reason: string } } }
    ).error;
    expect(brokeErr.code).toBe("E_PROVIDER_ERROR");
    expect(brokeErr.details.reason).toBe("insufficient_points");
  }, 30_000);

  it("恒 pending + 短超时 → E_PROVIDER_ERROR(timeout) 且 taskIds 保留", async () => {
    const r = await cli(["--json", "suno-gen", "--prompt", "stuck song"], {
      ...BASE_ENV(),
      SUNO_TIMEOUT_MS: "50",
    });
    expect(r.code).toBe(3);
    const err = (
      JSON.parse(r.stdout) as {
        error: { code: string; details: { reason: string; taskIds: number[] } };
      }
    ).error;
    expect(err.code).toBe("E_PROVIDER_ERROR");
    expect(err.details.reason).toBe("timeout");
    expect(err.details.taskIds).toEqual([998, 999]);
  }, 30_000);

  it("缺 SUNO_API_KEY → E_CONFIG 且不发请求；suno-download 缺 --id → E_MISSING_ARGUMENT", async () => {
    const before = mock.requests.length;
    const noKey = await cli(["--json", "suno-balance"], { ...BASE_ENV(), SUNO_API_KEY: undefined });
    expect(noKey.code).toBe(3);
    expect((JSON.parse(noKey.stdout) as { error: { code: string } }).error.code).toBe("E_CONFIG");
    expect(mock.requests.length).toBe(before);

    const noId = await cli(
      ["--json", "suno-download", "--output", path.join(dir, "z.mp3")],
      BASE_ENV(),
    );
    expect(noId.code).toBe(2);
    expect((JSON.parse(noId.stdout) as { error: { code: string } }).error.code).toBe(
      "E_MISSING_ARGUMENT",
    );
  }, 30_000);

  it("suno-gen 二选一校验：都缺 → E_MISSING_ARGUMENT；都给 → E_INVALID_OPTION", async () => {
    const neither = await cli(["--json", "suno-gen"], BASE_ENV());
    expect(neither.code).toBe(2);
    expect((JSON.parse(neither.stdout) as { error: { code: string } }).error.code).toBe(
      "E_MISSING_ARGUMENT",
    );

    const both = await cli(["--json", "suno-gen", "--prompt", "a", "--lyrics", "b"], BASE_ENV());
    expect(both.code).toBe(2);
    expect((JSON.parse(both.stdout) as { error: { code: string } }).error.code).toBe(
      "E_INVALID_OPTION",
    );
  }, 30_000);

  it("spec 自省含五个 suno-* 命令且 source 为 plugin:suno-music", async () => {
    const r = await cli(["--json", "spec"], BASE_ENV());
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const byName = new Map(parsed.data.commands.map((c) => [c.name, c]));
    for (const name of ["suno-gen", "suno-sound", "suno-task", "suno-download", "suno-balance"]) {
      expect(byName.get(name)?.source).toBe("plugin:suno-music");
    }
  });
});
