import { H3_DEFAULTS } from "./lib/defaults.mjs";
import { H3_PROMPT_MAX, H3_RATIOS, runH3Image } from "./lib/h3.mjs";
import {
  EDIT_DEFAULTS,
  FAST_DEFAULTS,
  GEN_DEFAULTS,
  PROMPT_MAX,
  RATIOS,
  runImageGen,
  STEPS_MAX,
} from "./lib/run.mjs";

// 三个 handler 都只把命令自己的 defaults 交给同一条流程（lib/run.mjs），差异全在 defaults 里；
// h3 的采样参数固定、prompt 上限也不同，单独走 lib/h3.mjs
const modelscopeImageGen = (ctx, args) => runImageGen(ctx, args, GEN_DEFAULTS);
const modelscopeImageFast = (ctx, args) => runImageGen(ctx, args, FAST_DEFAULTS);
const modelscopeImageEdit = (ctx, args) => runImageGen(ctx, args, EDIT_DEFAULTS);

// 三个命令共用的文本项（prompt 上限与 steps 上限都取实测硬拦值，见 lib/run.mjs 的注释）
const promptOption = () => ({
  flags: "--prompt <text>",
  description: `生图文案（必填；网关实测硬拦 ${PROMPT_MAX} 字符，按字符计不按字节，已本地预检）`,
});
const seedOption = () => ({
  flags: "--seed <n>",
  description: "随机种子（可选，0-2147483647，同 seed 可复现）",
});
const negativeOption = () => ({
  flags: "--negative-prompt <text>",
  description: "负向提示词（可选）",
});
const refOption = (flags, description) => ({ flags, description });

const REF_DESCRIPTION =
  "参考图公网 URL，可传多张（上限 10，走图生图/多图参考编辑；本地文件先用 tencent-cos-upload 换 URL）";

// edit 的头号差异：实测网关吃 data:image/...;base64, 形态，所以本地文件直接内联，不需要 CDN
const EDIT_REF_DESCRIPTION = `参考图，公网 URL 与本地文件路径可混传（上限 ${EDIT_DEFAULTS.refMax} 张，网关实测硬拦 "image_url count exceeds maximum limit of ${EDIT_DEFAULTS.refMax}"）；本地文件读成 data:image/<mime>;base64, 内联，不需要先上传 CDN`;

const stepsDescription = (extra) =>
  `采样步数（${extra}；范围 1-${STEPS_MAX}，网关实测硬拦 steps must be in [1,50]，本地先拦不吃 400）`;

// gen 与 fast 的选项集完全一致（§4.2），差异只在默认值，因此描述文本按命令传入
function generationOptions({ model, size, steps, guidance, output }) {
  return [
    promptOption(),
    { flags: "--model <id>", description: model },
    { flags: "--size <WxH>", description: size },
    {
      flags: "--ratio <name>",
      description: `按比例出图，映射到网关可用的最大档（${Object.keys(RATIOS).join("|")}），与 --size 二选一`,
    },
    { flags: "--steps <n>", description: steps },
    { flags: "--guidance <n>", description: guidance },
    seedOption(),
    negativeOption(),
    refOption("--ref <urls...>", REF_DESCRIPTION),
    { flags: "--output <path>", description: output },
  ];
}

// edit 没有 --ratio：编辑类任务通常要跟参考图保持一致的构图，尺寸就按 --size 显式给
function editOptions({ model, size, steps, guidance, output }) {
  return [
    promptOption(),
    { flags: "--model <id>", description: model },
    { flags: "--size <WxH>", description: size },
    { flags: "--steps <n>", description: steps },
    { flags: "--guidance <n>", description: guidance },
    seedOption(),
    negativeOption(),
    refOption("--ref <pathsOrUrls...>", EDIT_REF_DESCRIPTION),
    { flags: "--output <path>", description: output },
  ];
}

// H3 的独有契约：采样固定（不暴露 steps/guidance/negative-prompt）、prompt 上限来自 MiniMax 文档、
// 参考图原生支持本地文件内联（H3 网关未实测）、原生 4K 不在网关能力内（4096 本地即拒）
function h3Options() {
  return [
    {
      flags: "--prompt <text>",
      description: `生图文案（必填；MiniMax 文档上限 ${H3_PROMPT_MAX} 字符，按 Unicode 码点计，已本地预检）`,
    },
    {
      flags: "--model <id>",
      description: `模型 id（默认取 MODELSCOPE_H3_MODEL，内置 ${H3_DEFAULTS.modelFallback}）`,
    },
    {
      flags: "--size <WxH>",
      description:
        "尺寸，WxH 字符串（默认 1024x1024；ModelScope API-Inference 实测每边 [64,2048]，4096 本地即拒，4K 请用 minimax-image）",
    },
    {
      flags: "--ratio <name>",
      description: `按比例出图，映射到网关可用档（${Object.keys(H3_RATIOS).join("|")}），与 --size 二选一`,
    },
    seedOption(),
    {
      flags: "--ref <pathsOrUrls...>",
      description: `参考图，公网 URL 与本地文件路径可混传（1-${H3_DEFAULTS.refMax} 张；本地文件读成 data:image/<mime>;base64, 内联，不需要先上传 CDN）`,
    },
    {
      flags: "--output <path>",
      description: "输出图片路径（默认 ./modelscope-h3-<时间戳>.<扩展名>）",
    },
  ];
}

export default {
  name: "modelscope-image",
  version: "0.1.0",
  commands: [
    {
      name: "modelscope-image-gen",
      description:
        "ModelScope API-Inference 生图（Qwen-Image 系列，--model 默认取 MODELSCOPE_IMAGE_MODEL）",
      options: generationOptions({
        model: "模型 id（默认取 MODELSCOPE_IMAGE_MODEL，如 Qwen/Qwen-Image-2.1）",
        size: "尺寸，WxH 字符串（默认 1024x1024；网关实测每边 [64,2048]）",
        steps: stepsDescription("可选，不传即用 provider 默认"),
        guidance: "提示词引导系数（可选 1-20，不传即用 provider 默认）",
        output: "输出图片路径（默认 ./modelscope-<时间戳>.<扩展名>）",
      }),
      handler: modelscopeImageGen,
    },
    {
      name: "modelscope-image-fast",
      description:
        "ModelScope 快速文生图（默认 Qwen/Qwen-Image-2.1-Turbo + steps=8 + guidance=1 + 2048x2048，实测 37.1s 出最大尺寸）",
      options: generationOptions({
        model: `模型 id（默认取 MODELSCOPE_FAST_MODEL，内置 ${FAST_DEFAULTS.modelFallback}）`,
        size: "尺寸，WxH 字符串（默认 2048x2048，即网关每边实测上限）",
        steps: stepsDescription(`默认 ${FAST_DEFAULTS.stepsDefault}，Turbo 官方推荐档`),
        guidance: `提示词引导系数（默认 ${FAST_DEFAULTS.guidanceDefault}，范围 1-20；Turbo 官方 CFG）`,
        output: "输出图片路径（默认 ./modelscope-fast-<时间戳>.<扩展名>）",
      }),
      handler: modelscopeImageFast,
    },
    {
      name: "modelscope-image-edit",
      description:
        "ModelScope 图片编辑（Qwen/Qwen-Image-Edit：参考图可直接传本地文件，内联成 data URI，上限 4 张、不用先上 CDN；不传 --ref 即退化为文生图）",
      options: editOptions({
        model: `模型 id（默认取 MODELSCOPE_EDIT_MODEL，内置 ${EDIT_DEFAULTS.modelFallback}）`,
        size: "尺寸，WxH 字符串（默认 2048x2048；网关实测每边 [64,2048]，星号格式 1024*1024 会被拒）",
        steps: stepsDescription("可选，不传即用 provider 默认"),
        guidance:
          "提示词引导系数（可选 1-20，网关实测硬拦 guidance must be in [1.0,20.0]；Edit 的推荐 CFG 待实测）",
        output: "输出图片路径（默认 ./modelscope-edit-<时间戳>.<扩展名>）",
      }),
      handler: modelscopeImageEdit,
    },
    {
      name: "modelscope-image-h3",
      description:
        "ModelScope 生图/图片编辑（MiniMax-H3-Image：采样固定 6 steps / guidance 1、不吃 negative_prompt；参考图 1-16 张可直接传本地文件；每边 ≤2048；不传 --ref 即文生图；实测网关当前对该模型返回 40000）",
      options: h3Options(),
      handler: runH3Image,
    },
  ],
};
