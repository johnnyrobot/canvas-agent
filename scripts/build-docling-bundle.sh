#!/usr/bin/env bash
#
# Build a self-contained, RELOCATABLE docling-serve sidecar bundle for packaging.
#
# Strategy (validated by research, NOT PyInstaller): ship a python-build-standalone
# (PBS) CPython 3.13 with docling-serve's exact wheel closure installed into it, plus
# a relative `#!/bin/sh` launcher. PBS interpreters re-derive sys.prefix from their own
# location, so the whole tree relocates to <Resources>/sidecars/docling-serve/ in the
# packaged .app. The freezer route (PyInstaller/Nuitka) is a known trap for the
# torch/transformers/mlx stack; this ships the identical wheels that already work.
#
# Output: build/docling-serve/  — its immediate child `docling-serve` is the launcher
# leaf that resolveSidecarCommand spawns. Stage with:
#   DOCLING_SERVE_DIR="$PWD/build/docling-serve" npm run stage:sidecars
#
# Idempotent: wipes build/docling-serve and rebuilds. Requires: uv, the validated
# .venv-docling (source of the dependency closure). Run on arm64 hardware.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_VENV="$ROOT/.venv-docling"
OUT="$ROOT/build/docling-serve"
PYVER="3.13"

[ -x "$SRC_VENV/bin/python" ] || { echo "error: $SRC_VENV not found (the validated docling venv is the dependency source)"; exit 1; }
command -v uv >/dev/null || { echo "error: uv not on PATH (brew install uv)"; exit 1; }

echo "==> [1/7] clean output"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "==> [2/7] obtain a relocatable PBS CPython $PYVER via uv"
uv python install "$PYVER"
# Resolve the MANAGED standalone build explicitly (do NOT pick up the system framework
# python that .venv-docling uses — that one is not relocatable).
PBS_ROOT="$(ls -d "$HOME/.local/share/uv/python/"cpython-$PYVER*-macos-aarch64-none 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$PBS_ROOT" ] && [ -d "$PBS_ROOT" ] || { echo "error: could not locate a managed PBS cpython-$PYVER under ~/.local/share/uv/python"; exit 1; }
echo "    PBS root: $PBS_ROOT"

echo "==> [3/7] copy the standalone interpreter into the bundle (self-contained)"
cp -R "$PBS_ROOT" "$OUT/python"
PYBIN="$OUT/python/bin/python3"
# This is now OUR private bundle interpreter (not the shared uv-managed store), so the
# PEP-668 EXTERNALLY-MANAGED marker no longer applies — drop it so pip can install here.
rm -f "$OUT/python/lib/python$PYVER/EXTERNALLY-MANAGED"
"$PYBIN" --version

echo "==> [4/7] derive the dependency closure from the validated .venv-docling (minus ray/dev)"
# Full-env freeze = the exact transitive closure that already works. Drop ray (proven
# unused on the LOCAL engine), its jobkit siblings, and dev/build tooling.
"$SRC_VENV/bin/python" -m pip freeze \
  | grep -ivE '^(ray|kfp|datasets|jedi|ipython|ipykernel|jupyter[-a-z]*|virtualenv|pip|setuptools|wheel|pyinstaller|nuitka)([=<>! @]|$)' \
  | grep -v '@ file://' | grep -v '^-e ' > "$OUT/requirements.lock"
echo "    $(grep -c . "$OUT/requirements.lock") pinned packages"

echo "==> [5/7] install the closure into the bundled interpreter (--no-deps = exact set)"
"$PYBIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
"$PYBIN" -m pip install --no-deps --no-warn-script-location --disable-pip-version-check -r "$OUT/requirements.lock"

echo "==> [6/7] slim + add the relocatable launcher"
SP="$OUT/python/lib/python$PYVER/site-packages"
rm -rf "$SP"/ray "$SP"/ray-*.dist-info "$SP"/kfp* "$SP"/datasets* 2>/dev/null || true
find "$OUT/python" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT/python" -type d -name 'tests' -path '*/site-packages/*' -prune -exec rm -rf {} + 2>/dev/null || true
cat > "$OUT/docling-serve" <<'WRAP'
#!/bin/sh
# Relocatable launcher: run the bundled CPython's docling_serve from this dir.
# $DIR is resolved at runtime, so the bundle works at any path (no absolute shebang).
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$DIR/models" ] && [ -n "$(ls -A "$DIR/models" 2>/dev/null)" ]; then
  # Models EMBEDDED in the sidecar (DOCLING_BUNDLE_MODELS=1 build): serve fully
  # OFFLINE against them.
  export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
  export DOCLING_SERVE_ARTIFACTS_PATH="$DIR/models"
fi
# Default build: models live in the app's per-user store; the spawning app sets
# DOCLING_SERVE_ARTIFACTS_PATH + HF_HUB_OFFLINE for offline serving after the
# first-run download. Provide a writable HF cache default either way.
export HF_HOME="${HF_HOME:-${TMPDIR:-/tmp}/canvas-agent-hf}"
exec "$DIR/python/bin/python3" -m docling_serve run "$@"
WRAP
chmod +x "$OUT/docling-serve"

# Ship the first-run model-download driver beside the launcher. The app spawns it
# with the bundled python (src/ingest/model-download.ts resolves <dir>/download-models.py).
cp "$ROOT/scripts/docling-download-models.py" "$OUT/download-models.py"
chmod +x "$OUT/download-models.py"

echo "==> [7/8] models: first-run download by default (DOCLING_BUNDLE_MODELS=1 to embed)"
# By default the models are NOT bundled — they download into the app's per-user
# store on first run (keeps the DMG ~1.2GB smaller; see scripts/docling-download-models.py).
# Set DOCLING_BUNDLE_MODELS=1 for a fully-offline-out-of-the-box build that embeds
# the classic pipeline (layout, tableformer, code_formula, picture_classifier,
# rapidocr) + the Granite-Docling MLX VLM (with_granitedocling_mlx defaults to
# False upstream, so we opt in explicitly).
if [ "${DOCLING_BUNDLE_MODELS:-0}" = "1" ]; then
  if [ -d "$OUT/models" ] && [ -n "$(ls -A "$OUT/models" 2>/dev/null)" ]; then
    echo "    models already present — skipping (delete $OUT/models to refetch)"
  else
    echo "    embedding models (DOCLING_BUNDLE_MODELS=1) — classic + granite_docling MLX"
    "$PYBIN" -c "from docling.utils.model_downloader import download_models; from pathlib import Path; download_models(output_dir=Path('$OUT/models'), progress=False, with_granitedocling_mlx=True); print('    models downloaded (classic + granite_docling MLX)')"
  fi
else
  echo "    skipping embed — models download on first run into the app's per-user store."
fi

echo "==> [8/8] verify: in-place import + RELOCATED interpreter import"
"$PYBIN" -c "import docling_serve, docling, torch, transformers; print('  in-place imports OK')"
# Relocation proof: copy ONLY the interpreter (not the multi-GB models) to a new path.
RELOC="$(mktemp -d)"
cp -R "$OUT/python" "$RELOC/python"
"$RELOC/python/bin/python3" -c "import docling_serve, docling, torch; print('  relocated imports OK')"
rm -rf "$RELOC"

echo ""
echo "✓ docling bundle built: $OUT"
du -sh "$OUT" 2>/dev/null
echo "  next: pre-stage model weights, then DOCLING_SERVE_DIR=$OUT npm run stage:sidecars"
