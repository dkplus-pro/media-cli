import { FAST_DEFAULTS, GEN_DEFAULTS, PROMPT_MAX, RATIOS, runImageGen } from "./lib/run.mjs";

// 两个 handler 都只把命令自己的 defaults 交给同一条生成流程（lib/run.mjs）
const modelscopeImageGen = (ctx, args) => runImageGen(ctx, args, GEN_DEFAULTS);
const modelscopeImageFast = (ctx, args) => runImageGen(ctx, args, FAST_DEFAULTS);

const REF_DESCRIPTION =
  "参考图公网 URL，可传多张（上限 10，走图生图/多图参考编辑；本地文件先用 tencent-cos-upload 换 URL）";

// 两个命令的选项集完全一致（§4.2），差异只在默认值，因此描述文本按命令传入
function commandOptions({ model, size, steps, guidance, output }) {
  return [
    {
      flags: "--prompt <text>",
      description: `生图文案（必填；网关实测硬拦 ${PROMPT_MAX} 字符，按字符计不按字节，已本地预检）`,
    },
    { flags: "--model <id>", description: model },
    { flags: "--size <WxH>", description: size },
    {
      flags: "--ratio <name>",
      description: `按比例出图，映射到网关可用的最大档（${Object.keys(RATIOS).join("|")}），与 --size 二选一`,
    },
    { flags: "--steps <n>", description: steps },
    { flags: "--guidance <n>", description: guidance },
    { flags: "--seed <n>", description: "随机种子（可选，0-2147483647，同 seed 可复现）" },
    { flags: "--negative-prompt <text>", description: "负向提示词（可选）" },
    { flags: "--ref <urls...>", description: REF_DESCRIPTION },
    { flags: "--output <path>", description: output },
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
      options: commandOptions({
        model: "模型 id（默认取 MODELSCOPE_IMAGE_MODEL，如 Qwen/Qwen-Image-2.1）",
        size: "尺寸，WxH 字符串（默认 1024x1024；网关实测每边 [64,2048]）",
        steps: "采样步数（可选 1-100，不传即用 provider 默认）",
        guidance: "提示词引导系数（可选 1-20，不传即用 provider 默认）",
        output: "输出图片路径（默认 ./modelscope-<时间戳>.<扩展名>）",
      }),
      handler: modelscopeImageGen,
    },
    {
      name: "modelscope-image-fast",
      description:
        "ModelScope 快速文生图（默认 Qwen/Qwen-Image-2.1-Turbo + steps=8 + guidance=1 + 2048x2048，实测 37.1s 出最大尺寸）",
      options: commandOptions({
        model: `模型 id（默认取 MODELSCOPE_FAST_MODEL，内置 ${FAST_DEFAULTS.modelFallback}）`,
        size: "尺寸，WxH 字符串（默认 2048x2048，即网关每边实测上限）",
        steps: `采样步数（默认 ${FAST_DEFAULTS.stepsDefault}，范围 1-100；Turbo 官方推荐档）`,
        guidance: `提示词引导系数（默认 ${FAST_DEFAULTS.guidanceDefault}，范围 1-20；Turbo 官方 CFG）`,
        output: "输出图片路径（默认 ./modelscope-fast-<时间戳>.<扩展名>）",
      }),
      handler: modelscopeImageFast,
    },
  ],
};
