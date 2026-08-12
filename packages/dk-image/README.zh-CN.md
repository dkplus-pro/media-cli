# @dkplus/dk-image

`dk-image` 是第一阶段的图片 CLI。它发布七个命令：本地图片信息读取、通过注入 Provider 的 AI 内容分析，以及非破坏性水印。

```bash
dk-image content metadata photo.png
dk-image content describe photo.png
dk-image content keywords photo.png
dk-image content ocr photo.png
dk-image content score photo.png
dk-image analyze photo.png
dk-image watermark photo.png --output photo-watermarked.png --text "DKPLUS"
```

通过 CLI 调用时，`content describe`、`content keywords`、`content ocr`、`content score` 和 `analyze` 使用显式 JSON Profile 文件。通过 `--config <path>` 指定：

```json
{
  "profiles": [
    {
      "id": "image-analysis",
      "provider": "openai-compatible",
      "features": ["image.content.*"],
      "config": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "replace-with-a-secret",
        "model": "example-model"
      }
    },
    {
      "id": "azure-images",
      "provider": "azure",
      "features": ["image.content.describe"],
      "config": {
        "endpoint": "https://example.openai.azure.com",
        "apiKey": "replace-with-a-secret",
        "deployment": "image-deployment",
        "apiVersion": "2024-10-21"
      }
    }
  ]
}
```

每个 Profile 都有唯一的 `id`、`azure` 或 `openai-compatible` Provider、至少一个精确或 `.*` 结尾的 feature 路由，以及上述 Provider 对应的 `config`。按数组顺序使用第一个匹配的路由。例如：`dk-image content describe photo.png --config image-ai.json --json`。

CLI 只从选定的文件读取凭据，不读取或打印进程环境变量中的凭据。文件缺失或无效时返回经过脱敏的 `AI_CONFIGURATION_INVALID` 类型错误。请勿将该文件提交到版本库。作为 API 使用时，内容领域函数仍然需要注入 `@dkplus/ai-core` Provider；图片字节与源文件指纹会传给路由后的 feature。

`analyze` 仅组合 metadata、description、keywords、OCR 和 score。分数会严格校验在 0 到 10（含）之间。每个命令均支持 `--help`、`--version`、`--schema`、`--config <path>`、`--json` 及共享基础选项。

水印仅写入输出文件：目标已存在时必须使用 `--force`，且无论是否强制，任何解析后与输入文件相同的输出路径都会被拒绝。

第一阶段明确不包含图片生成。本包没有 `generate` 命令，也没有生成 API。
