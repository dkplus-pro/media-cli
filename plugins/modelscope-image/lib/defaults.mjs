import { DEFAULT_EDIT_MODEL, DEFAULT_FAST_MODEL } from "./env.mjs";

// 三条命令（gen / fast / edit）走同一条流程（lib/run.mjs 的 runImageGen），
// 全部差异收敛在这里这三份 defaults（阶段 07 §4.2 的做法）。
// defaults 里存的是**环境变量名**而非值，run.mjs 用 MODEL_CONFIG_FIELD 映射到 loadConfig 的字段。

// --ref 张数上限：网关按模型而变，两条实测数字各归各的
// gen/fast（Qwen-Image-2.1 系列）：卡片标 10 张，实测 11 张本地拒即可省一次 400
export const REF_MAX_GENERATION = 10;
// edit（Qwen/Qwen-Image-Edit）：实测硬拦，原文 `image_url count 9 exceeds maximum limit of 4`
export const REF_MAX_EDIT = 4;

export const GEN_DEFAULTS = {
  modelVar: "MODELSCOPE_IMAGE_MODEL",
  // 无内置默认模型：模型 id 按月变，缺 env 直接 E_CONFIG（与 doubao 的房子规则一致）
  modelFallback: "",
  stepsDefault: undefined,
  guidanceDefault: undefined,
  // 下限从 1.5 放宽到 1：网关实测 CFG=1 可用，而 1 正是 Turbo 的官方默认值（D25）
  guidanceMin: 1,
  sizeDefault: "1024x1024",
  filePrefix: "modelscope-",
  refMax: REF_MAX_GENERATION,
  // 只收公网 URL：本地文件不做隐式上传（历史契约，2.1 这条链路未验证过 data URI）
  localRefs: false,
};

export const FAST_DEFAULTS = {
  modelVar: "MODELSCOPE_FAST_MODEL",
  // 实测 Turbo 网关可直接调；模型页元数据 SupportApiInference=false 不可信（在用的 base 2.1 同样是 false）
  modelFallback: DEFAULT_FAST_MODEL,
  stepsDefault: 8,
  guidanceDefault: 1,
  guidanceMin: 1,
  // 用户要最大尺寸：实测 2048x2048 真出 2048x2048（每边网关上限就是 2048）
  sizeDefault: "2048x2048",
  filePrefix: "modelscope-fast-",
  refMax: REF_MAX_GENERATION,
  localRefs: false,
};

export const EDIT_DEFAULTS = {
  modelVar: "MODELSCOPE_EDIT_MODEL",
  // 实测（2026-10-15）Qwen/Qwen-Image-Edit 经同一网关可调，且同样不吃 SupportApiInference 字段；
  // 与 fast 一样的先例：内置默认值，不配 env 也能直接跑
  modelFallback: DEFAULT_EDIT_MODEL,
  // 不干预采样参数：Edit 的官方推荐步数/CFG 未实测，交给 provider 默认
  stepsDefault: undefined,
  guidanceDefault: undefined,
  guidanceMin: 1,
  // 与 fast 同用网关每边实测上限（2048）；编辑类任务丢细节主要靠分辨率
  sizeDefault: "2048x2048",
  filePrefix: "modelscope-edit-",
  refMax: REF_MAX_EDIT,
  // 实测 data URI 被真实消费 → 本地文件直接内联，不需要先 tencent-cos-upload
  localRefs: true,
};

// defaults 存环境变量名，loadConfig 已把变量读成 camelCase 字段，这里做一次映射
export const MODEL_CONFIG_FIELD = {
  MODELSCOPE_IMAGE_MODEL: "model",
  MODELSCOPE_FAST_MODEL: "fastModel",
  MODELSCOPE_EDIT_MODEL: "editModel",
};
