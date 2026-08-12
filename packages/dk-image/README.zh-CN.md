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

作为 API 使用时，`content describe`、`content keywords`、`content ocr` 和 `content score` 需要注入 `@dkplus/ai-core` Provider。图片字节在本地加载，连同源文件指纹发送给对应 feature；领域包不会读取 Provider 配置或密钥。

`analyze` 仅组合 metadata、description、keywords、OCR 和 score。分数会严格校验在 0 到 10（含）之间。每个命令均支持 `--help`、`--version`、`--schema`、`--json` 及共享基础选项。

水印仅写入输出文件：目标已存在时必须使用 `--force`，且无论是否强制，任何解析后与输入文件相同的输出路径都会被拒绝。

第一阶段明确不包含图片生成。本包没有 `generate` 命令，也没有生成 API。
