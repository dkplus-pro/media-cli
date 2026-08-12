# @dkplus/dk-image

`dk-image` is the phase-one image CLI. It publishes seven commands for local image inspection, AI-assisted content analysis through an injected provider, and non-destructive watermarking.

```bash
dk-image content metadata photo.png
dk-image content describe photo.png
dk-image content keywords photo.png
dk-image content ocr photo.png
dk-image content score photo.png
dk-image analyze photo.png
dk-image watermark photo.png --output photo-watermarked.png --text "DKPLUS"
```

`content describe`, `content keywords`, `content ocr`, and `content score` require an injected `@dkplus/ai-core` provider when used as APIs. They load image bytes locally, send image data plus the source fingerprint to the configured feature, and never read provider configuration or secrets in the domain package.

`analyze` combines exactly metadata, description, keywords, OCR, and score. Scores are validated from 0 through 10 inclusive. Each command supports `--help`, `--version`, `--schema`, `--json`, and the shared base options.

Watermarking is output-only: it refuses an existing output unless `--force` is set, and it always rejects an output path that resolves to the input image.

Image generation is explicitly excluded from phase one. There is no `generate` command or generation API in this package.
