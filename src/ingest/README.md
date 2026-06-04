# `src/ingest` — Document ingestion sidecar (Docling)

Read-only conversion of **user-supplied** DOCX/PPTX/XLSX/PDF/images → structured
content (Markdown / HTML / JSON / DocTags) via a bundled local **`docling-serve`**
HTTP sidecar (PRD §16). No cloud, no external API; the app **never tags or
remediates** the source document — it only reads it.

## Layout

| File | Responsibility |
|---|---|
| `types.ts` | Public types (`ConvertOptions`, `ConvertedDocument`, `FileSource`) |
| `config.ts` | Env → config (PRD Appendix H) — **pure** |
| `payload.ts` | Build `/v1/convert/source` bodies; normalize response — **pure** |
| `process.ts` | Spawn / attach / stop `docling-serve` |
| `client.ts` | `fetch` client for `POST /v1/convert/source` |
| `sidecar.ts` | Facade: `start/stop/convert/convertPath/convertUrl` |
| `*.test.ts` | Unit tests for the pure logic |

## Usage

```ts
import { createDoclingSidecar } from './ingest/index.js';

const docling = createDoclingSidecar();
await docling.start();                                  // attach-or-spawn docling-serve

const result = await docling.convertPath('./syllabus.docx', { toFormats: ['html', 'json'] });
// result.html / result.json / result.markdown / result.status / result.processingTimeMs

await docling.stop();
```

The Granite-Docling-258M VLM and OcrMac handle the scanned-page OCR path *inside*
docling-serve (PRD §16.3); this client just selects `do_ocr` / `force_ocr`.

## API verified against docling-serve

- `POST /v1/convert/source` — JSON with `http_sources` / `file_sources`.
- Options: `to_formats` (`md`/`json`/`html`/`text`/`doctags`), `do_ocr`, `force_ocr`.
- Response: `document.{md,html,text,json,doctags}_content`, `status`, `processing_time`.
- Default port `5001`; start with `docling-serve run`.

## Scaffold status / TODO

- ✅ Pure logic (config, payload, response normalization) unit-tested.
- ⬜ Integration tests against a real docling-serve (needs the Python service).
- ⬜ **`ocr_engine` is deprecated upstream** in favor of `ocr_preset`; map
  `DOCLING_OCR_ENGINE=ocrmac` → the correct preset once confirmed against the
  installed version. Health endpoint is undocumented — we treat any HTTP response
  as "up"; switch to a real `/health` if one exists.
- ⬜ Async endpoints (`/v1/convert/source/async` + `GET /v1/status/poll/{id}`) for
  large docs; v1 uses the synchronous endpoint with a generous timeout.
- ⬜ Map the `ConvertedDocument` into the §16.2 accessible-HTML mapper.
