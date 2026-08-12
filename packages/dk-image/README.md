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

`content describe`, `content keywords`, `content ocr`, `content score`, and `analyze` use an explicit JSON profile file when invoked through the CLI. Pass it with `--config <path>`:

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

Each profile has a unique `id`, an `azure` or `openai-compatible` provider, at least one exact or `.*` feature route, and the provider-specific `config` shown above. The first matching route is used. For example: `dk-image content describe photo.png --config image-ai.json --json`.

The CLI reads credentials only from this selected file; it does not read or print process-environment credentials. Missing or invalid files return a typed, sanitized `AI_CONFIGURATION_INVALID` error. Keep the file out of source control. Programmatic content APIs still require an injected `@dkplus/ai-core` provider; image bytes and the source fingerprint are passed to the routed feature.

`analyze` combines exactly metadata, description, keywords, OCR, and score. Scores are validated from 0 through 10 inclusive. Each command supports `--help`, `--version`, `--schema`, `--config <path>`, `--json`, and the shared base options.

Watermarking is output-only: it refuses an existing output unless `--force` is set, and it always rejects an output path that resolves to the input image.

Image generation is explicitly excluded from phase one. There is no `generate` command or generation API in this package.
