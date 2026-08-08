---
status: accepted
---

# Bundle the document models, pull the LLM weights

Canvas Agent runs two kinds of model: Docling's document-conversion models and
Ollama's LLMs. 0.1.0 bundled the Docling models (1.9 GB DMG); 0.2.0 un-bundled
them for size (922 MB DMG) and downloads them on first run. We will **re-bundle
the Docling models** — the classic pipeline *and* Granite-Docling — so ingestion
is offline out of the box, and keep the two Ollama models as **first-run pulls**.

## Why the asymmetry

It is a size decision, and only a size decision.

| | Bundled | Cost |
|---|---|---|
| Docling classic + Granite-Docling MLX | yes | ~1.2 GB of DMG |
| `granite4.1:8b` + the vision model | no | 8.6 GB, pulled after install |

Bundling everything would mean a ~10 GB download before the app opens. Bundling
nothing means first run cannot convert a PDF until a second, separate download
finishes. The split follows the cost: 1.2 GB is affordable inside the DMG, 8.6 GB
is not.

The second input is UX asymmetry. Ollama has a first-class streaming pull with
progress, and the app already wraps it (`pullModel`, and the renderer's download
affordance). Docling has no equivalent — its first-run path is a bespoke driver
(`src/ingest/model-download.ts`) that exists only because 0.2.0 un-bundled the
models. Bundling deletes that path's reason to exist rather than improving it.

The capability is not new: `scripts/build-docling-bundle.sh:95-101` already takes
`DOCLING_BUNDLE_MODELS=1` and calls `download_models(..., with_granitedocling_mlx=True)`.
This decision makes that flag the default for release builds. No new download
path is written.

## Consequences

**The bundle is read-only, and that splits an overloaded term.** `modelsDir`
currently means both *where models are read from* (`spawnSpec()` points
`DOCLING_SERVE_ARTIFACTS_PATH` at it; `modelsPresent()` tests it) and *where the
first-run download writes to* (`model-download.ts:103` passes it as the driver's
output dir and creates `<modelsDir>/.hf-cache` inside it). Today those are always
the same directory, so the overload is invisible. Bundling pulls them apart: the
models are read from a code-signed `.app` bundle that must never be written to,
because writing there breaks the signature Gatekeeper checks.

**"Models are bundled" must therefore be a known fact, not an inferred one.** It
is resolved in `src/runtime/bundled-resources.ts`, beside `resolveSidecarCommand`,
which already knows the bundle layout. The tempting cheaper fix — leave
`DOCLING_MODELS_DIR` unset when bundled, so `modelsPresent()` returns `true` — was
rejected because that `true` comes from the optimistic fallback at
`src/ingest/process.ts:60`, whose own comment reads *"without it we can't tell…
so we optimistically report true."* The app would be right by luck rather than by
knowledge, and the next person to tighten that fallback would break bundling
without touching it.

**`DOCLING_SERVE_LOAD_MODELS_AT_BOOT=0` must survive.** `spawnSpec()`
(`src/ingest/process.ts:87-95`) sets four environment variables under
`if (this.config.modelsDir)`; the bundle's launcher
(`scripts/build-docling-bundle.sh:69-74`) re-exports only three and has never set
the boot flag. Any fix that unsets `modelsDir` silently re-enables boot-time model
loading in exactly the build with the heaviest payload — the failure
`process.ts:91-93` documents: a 60-second hung readiness wait instead of a clean
per-conversion error.

**`pre-release --strict` needs a new check, not a tightened one.** There is no
Docling assertion in `scripts/pre-release.mjs` today. The new one must gate on
**size**, modelled on the catalog-seed check at `pre-release.mjs:96-109`, not on
directory presence: a partial Hugging Face fetch leaves a populated-but-incomplete
`models/`, which is precisely the failure mode that shipped a half-mirrored
catalog past a presence check.

**Licensing flips in both directions.** `THIRD-PARTY-NOTICES.md` §"Bundled model
weights" currently describes a bundle that does not exist — stale from 0.1.0,
never updated when 0.2.0 un-bundled. This makes it true again, and
Granite-Docling must be added to that table; it is absent today. §"Model weights
used at runtime" keeps its shape but changes vendor.

**Issue #24 (the Docling model-download child is orphaned on quit) becomes moot
for bundled builds** — there is no first-run download to orphan. It still applies
to any build made without `DOCLING_BUNDLE_MODELS=1`, so it stays open.

The DMG lands somewhere near 2.1 GB. Treat that as an estimate to verify, not a
budget: the ~1.2 GB figure comes from a comment
(`build-docling-bundle.sh:90`) describing the *classic* payload, while the 0.2.0
un-bundling delta was ~1.0 GB, and Granite-Docling MLX is additional to both.
Measure after the first `DOCLING_BUNDLE_MODELS=1` build.
