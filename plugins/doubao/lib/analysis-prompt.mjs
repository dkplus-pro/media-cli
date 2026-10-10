import { cliError } from "./errors.mjs";

// 分析 schema：在转写之外补齐视频配乐决策所需的维度（BPM/调性/人声角色/记忆点/一句话总结）
const ANALYSIS_PROMPT = `你是一位专业音乐分析师与视频配乐顾问。仔细聆听这段音频，输出一个合法 JSON 对象描述这段音乐，只输出 JSON 本身，不要 markdown 代码块、不要任何其他文字。所有描述性文字用中文（genre 可保留英文风格名）。结构必须满足：

{
  "isMusic": true 或 false,          // 是否为音乐（含人声演唱；纯说话/环境音为 false，此时其余字段给出尽力而为的描述）
  "hasVocals": true 或 false,        // 是否包含人声演唱
  "vocalRole": "无" | "主导" | "伴唱/和声" | "念白",
  "genre": ["风格，如 Cinematic / Orchestral / 流行 / 电子"],
  "emotion": {
    "primary": "主情感，如 温暖治愈",
    "secondary": ["次要情感，0-3 个"],
    "intensity": "低" | "中" | "高"
  },
  "tempo": { "bpm": 估算数字或 null, "feel": "慢板 | 中板 | 快板 等" },
  "key": "调性如 C 大调，不确定给 null",
  "instruments": ["出现的乐器，按显著程度排序"],
  "structure": [
    // 音乐分段：情绪/配器/节奏明显变化处切分，必须连续覆盖 0 秒到音频结尾，不得遗漏尾声
    {
      "startSec": 数字,
      "endSec": 数字,
      "label": "前奏/主歌/副歌/间奏/尾声 或自由描述",
      "emotion": "该段情感",
      "intensity": "低" | "中" | "高",
      "description": "该段发生了什么（配器/节奏/旋律变化）"
    }
  ],
  "videoFit": {
    "scenes": ["适用视频场景，如 vlog 开场 / 产品宣传 / 旅行记录"],
    "moods": ["适配的情绪基调"],
    "unsuitable": ["不适合的场景"],
    "suggestedUse": "一句话剪辑建议（怎么用、卡什么点）"
  },
  "highlight": {
    "startSec": 数字或 null,
    "endSec": 数字或 null,
    "reason": "为什么是记忆点"
  },
  "oneLineSummary": "一句话总结这段音乐"
}`;

// 长曲分段分析：只看本段、时间相对本段起点，全局图景由合并请求汇总
function chunkPrompt(index, total, startSec, endSec) {
  return `你是一位专业音乐分析师。这是某首音乐的第 ${index + 1} 段（共 ${total} 段），本段对应全曲的 ${startSec}-${endSec} 秒。仔细聆听本段音频，输出一个合法 JSON 对象，只输出 JSON 本身，不要 markdown 代码块、不要其他文字，描述文字用中文。注意：structure 的 startSec/endSec 是**相对本段开头**的秒数。结构必须满足：

{
  "isMusic": true 或 false,
  "hasVocals": true 或 false,
  "genre": ["本段体现的风格"],
  "emotion": { "primary": "主情感", "secondary": ["次要情感"], "intensity": "低" | "中" | "高" },
  "tempo": { "bpm": 数字或 null, "feel": "慢板 | 中板 | 快板 等" },
  "key": "调性或 null",
  "instruments": ["本段出现的乐器"],
  "structure": [{ "startSec": 数字, "endSec": 数字, "label": "段落名", "emotion": "该段情感", "intensity": "低" | "中" | "高", "description": "该段内容（配器/节奏/旋律变化）" }],
  "notes": "对本曲整体风格/走向的观察（供后续汇总，一两句）"
}`;
}

// 长曲合并：把各段观察汇成一份全局一致的完整分析，时间轴还原为全曲绝对秒
function mergePrompt(parts, durationSec) {
  const sections = parts
    .map(
      (p, i) =>
        `【第 ${i + 1} 段｜全曲 ${p.startSec}-${p.endSec} 秒】\n${JSON.stringify(p.analysis)}`,
    )
    .join("\n\n");
  return `你是一位专业音乐分析师。下面是同一首音乐（全曲 ${durationSec} 秒）按时间顺序切分的各段分析 JSON。请汇总成一份**全局一致**的完整音乐分析，输出一个合法 JSON 对象，只输出 JSON 本身，不要 markdown 代码块、不要其他文字，描述文字用中文。要求：

- genre/emotion/tempo/key/instruments/videoFit/highlight/oneLineSummary 按全曲整体给出（综合各段，不要逐段罗列）。
- structure 合并各段的结构并用**全曲绝对秒**表示（第 i 段内部时间 + 该段起始偏移），相邻段的段落若本是一体要合并；时间轴必须连续覆盖 0 到 ${durationSec} 秒，不得遗漏尾声。
- 保留各段 structure 里的 emotion/intensity/description，description 可适当精炼。

${sections}`;
}

// 从模型文本中提取 JSON：容忍 ```json 围栏与前后闲话，取第一个配平的大括号块
export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  if (start === -1) {
    throw cliError("E_PROVIDER_ERROR", "doubao 音乐分析结果不含 JSON 对象", {
      reason: "bad_json",
      body: raw.slice(0, 200),
    });
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(body.slice(start, i + 1));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not an object");
          }
          return parsed;
        } catch {
          throw cliError("E_PROVIDER_ERROR", "doubao 音乐分析结果不是合法 JSON 对象", {
            reason: "bad_json",
            body: body.slice(start, Math.min(i + 1, start + 200)),
          });
        }
      }
    }
  }
  throw cliError("E_PROVIDER_ERROR", "doubao 音乐分析结果 JSON 不完整", {
    reason: "bad_json",
    body: body.slice(start, start + 200),
  });
}

// 时间戳漂移兜底：模型在长音频上偶尔漏标尾部甚至整段缺失，检测到就提示（不改动模型输出）
export function structureCovers(structure, durationSec, toleranceSec = 30) {
  if (!Array.isArray(structure) || structure.length === 0) return false;
  const last = structure[structure.length - 1];
  if (typeof last?.endSec !== "number") return false;
  return durationSec - last.endSec <= toleranceSec;
}

export const prompts = { analysis: ANALYSIS_PROMPT, chunkPrompt, mergePrompt };
