# `src/llm` — Local LLM inference sidecar

Manages the on-device **Gemma 4 12B** model via **Ollama** and exposes a small,
role-based API to the rest of the app. There is **no cloud LLM and no external
API** — this is the runtime layer the orchestrator (PRD §13/§15) sits on top of.

> Scope: this module is **transport + lifecycle only**. It does *not* enforce the
> Canvas allowlist or any accessibility gate — those are deterministic,
> server-side stages elsewhere in the pipeline (PRD §13.3/§15.7). The model output
> is never trusted directly.

## Layout

| File | Responsibility |
|---|---|
| `types.ts` | Public types (`ModelRole`, `ChatMessage`, `ChatOptions`, …) |
| `config.ts` | Load config from env (PRD Appendix H) — **pure** |
| `payload.ts` | Build native Ollama `/api/chat` bodies; role→model; vision flattening — **pure** |
| `ndjson.ts` | Parse Ollama's streaming NDJSON — **pure** |
| `client.ts` | `fetch`-based client for `/api/chat` (stream + non-stream) |
| `process.ts` | Spawn / attach / warm-load / stop `ollama serve` |
| `mutex.ts` | Single-user serialization (`OLLAMA_NUM_PARALLEL=1`) |
| `sidecar.ts` | Facade: `start` / `stop` / `chat` / `chatStream` / `chatJSON` / `describeImage` |
| `*.test.ts` | Unit tests for the pure logic (`node:test`) |
| `example.ts` | Runnable smoke script |

## Why the native API (not `/v1/chat/completions`)

Ollama exposes both an OpenAI-compatible endpoint and its native API on the same
port. We call the **native `/api/chat`** internally because it exposes controls
the PRD needs that the OpenAI shim omits: `num_ctx`, `keep_alive`, structured
`format` (JSON / JSON-Schema, PRD §15.4), `think` mode, and the `images` array
for vision. The OpenAI-compatible endpoint remains available for external tools.

## Usage

```ts
import { createOllamaSidecar } from './llm/index.js';

const llm = createOllamaSidecar();           // reads env (PRD Appendix H)
await llm.start();                           // attach-or-spawn ollama + warm-load

// Streaming text (role-based; never hard-code a model)
for await (const { delta } of llm.chatStream({ role: 'fast', messages: [
  { role: 'user', content: 'How do I make a Canvas table accessible?' },
]})) process.stdout.write(delta);

// Structured JSON (e.g. the remediation ChangeLog — schema-validate downstream)
const changeLog = await llm.chatJSON({ role: 'deep', schema: myJsonSchema, messages: [...] });

// Alt text for a USER-SUPPLIED image (never fetched — PRD §16.3)
const alt = await llm.describeImage({ image: base64, prompt: 'Concise alt text (<=80 chars).' });

await llm.stop();                            // only kills ollama if we spawned it
```

Wire `llm.stop()` to `SIGINT`/`SIGTERM` (see `example.ts`).

## Configuration (env)

See PRD Appendix H. Key vars: `LLM_BASE_URL` (default `http://localhost:11434/v1`),
`MODEL_TEXT`/`MODEL_VISION`/`MODEL_FAST`/`MODEL_DEEP`/`MODEL_CHEAP`
(default `gemma4:12b-mlx`), `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE`,
`OLLAMA_NUM_PARALLEL`, `LLM_NUM_CTX`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_TEMPERATURE`,
`LLM_TIMEOUT_MS`, `LLM_VISION_ENABLED`, `LLM_MANAGE_PROCESS`.

## Develop / verify

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit tests for the pure logic (no Ollama needed)

# Integration smoke (requires `ollama` + `ollama pull gemma4:12b-mlx`):
npm run llm:smoke -- "Explain accessible headings in one sentence."
npm run llm:smoke -- "Describe this image" ./some-image.png
```

## Scaffold status / TODO

- ✅ Pure logic (config, payload, NDJSON) covered by unit tests.
- ⬜ Integration tests against a real Ollama (process spawn, chat, vision) — need
  the `ollama` binary + model; not runnable in CI without it.
- ⬜ Retry/backoff policy and structured error taxonomy.
- ⬜ `chatJSON` repair/retry loop — currently throws `OllamaJsonError`; the
  orchestrator owns repair + schema validation (PRD §15.4).
- ⬜ Audio input helper (Gemma 4 supports ≤30 s audio) — add when the ingest/STT
  path is specified.
- ⬜ Health/readiness surfaced to the app UI (warm vs cold).
