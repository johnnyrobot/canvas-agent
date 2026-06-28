#!/usr/bin/env python3
"""First-run Docling model downloader.

Run by the bundled CPython to fetch the conversion models into a writable,
per-user directory (NOT bundled in the .app — keeps the DMG small). Unlike
Ollama's streaming `/api/pull`, Docling has no streaming pull API, so this
driver downloads each model in turn and emits ONE NDJSON progress line per step
to stdout for the TypeScript side (`src/ingest/model-download.ts`) to parse:

    {"status": "downloading", "model": "layout", "completed": 0, "total": 6}
    {"status": "model_done",  "model": "layout", "completed": 1, "total": 6}
    ...
    {"status": "success", "completed": 6, "total": 6}

On failure it prints a single {"error": "..."} line and exits non-zero. It must
run ONLINE (the caller clears HF_HUB_OFFLINE); serving is offline afterwards.

The set below covers EVERY input format the app accepts: office/web/markdown
parse with no models, while PDFs and scanned images need the classic stack
(layout + TableFormer + OCR + code/formula + picture-classifier) and, for the
opt-in VLM pipeline, the Granite-Docling MLX weights.
"""
import json
import sys
from pathlib import Path

# download_models() defaults several flags to True; to fetch exactly one model
# per step we pass ALL flags False except the target, so each step is isolated
# and we can emit honest per-model progress.
ALL_FLAGS = [
    "with_layout",
    "with_tableformer",
    "with_tableformer_v2",
    "with_code_formula",
    "with_picture_classifier",
    "with_smolvlm",
    "with_granitedocling",
    "with_granitedocling_mlx",
    "with_granitedocling_2stage",
    "with_smoldocling",
    "with_smoldocling_mlx",
    "with_granite_vision",
    "with_granite_chart_extraction",
    "with_granite_chart_extraction_v4",
    "with_rapidocr",
    "with_easyocr",
]

# (label, flag) in download order. Classic PDF/image stack + the Granite-Docling
# MLX VLM (the deep-research-recommended on-device model).
MODELS = [
    ("layout", "with_layout"),
    ("tableformer", "with_tableformer"),
    ("code_formula", "with_code_formula"),
    ("picture_classifier", "with_picture_classifier"),
    ("rapidocr", "with_rapidocr"),
    ("granite_docling", "with_granitedocling_mlx"),
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"error": "usage: docling-download-models.py <output_dir>"})
        return 1
    out = Path(sys.argv[1])
    try:
        out.mkdir(parents=True, exist_ok=True)
    except Exception as e:  # noqa: BLE001 — surface any FS error as a clean line
        emit({"error": f"cannot create output dir {out}: {e}"})
        return 1

    try:
        from docling.utils.model_downloader import download_models
    except Exception as e:  # noqa: BLE001
        emit({"error": f"docling import failed: {e}"})
        return 1

    total = len(MODELS)
    for i, (label, flag) in enumerate(MODELS):
        emit({"status": "downloading", "model": label, "completed": i, "total": total})
        kwargs = {f: False for f in ALL_FLAGS}
        kwargs[flag] = True
        try:
            download_models(output_dir=out, progress=False, **kwargs)
        except Exception as e:  # noqa: BLE001
            emit({"error": f"failed downloading {label}: {e}"})
            return 1
        emit({"status": "model_done", "model": label, "completed": i + 1, "total": total})

    emit({"status": "success", "completed": total, "total": total})
    return 0


if __name__ == "__main__":
    sys.exit(main())
