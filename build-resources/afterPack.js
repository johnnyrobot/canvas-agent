/**
 * electron-builder `afterPack` hook — Developer-ID sign the bundled sidecars
 * (the Ollama runner set + the docling-serve PBS bundle) under hardened runtime,
 * BEFORE electron-builder signs the outer .app.
 *
 * Why this exists (validated against electron-builder 26.8.1 + @electron/osx-sign):
 *  1. osx-sign discovers nested binaries with a null-byte heuristic (isBinaryFile),
 *     NOT Mach-O magic — so it would hand every one of the docling bundle's ~20k
 *     `.pyc` files and data blobs to `codesign`, which errors on non-Mach-O and
 *     ABORTS the whole build. We add `/Contents/Resources/sidecars/` to
 *     `mac.signIgnore` so osx-sign skips that tree, and sign it correctly here.
 *  2. Some bundled libs are ad-hoc-signed (torch) or signed by another team
 *     (Ollama: Infra Technologies). The Apple notary service REJECTS ad-hoc/
 *     unsigned Mach-O, so we re-sign EVERY real Mach-O with our Developer ID +
 *     `--options runtime` + `--timestamp` and the project's entitlements (which
 *     include disable-library-validation / allow-jit / allow-unsigned-executable-
 *     memory — exactly what a non-Apple Python + torch/mlx JIT need).
 *
 * The outer app signature still seals these files as resources (they are stable
 * by the time electron-builder signs, since this hook runs first).
 */
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileP = promisify(execFile);
const ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.plist');

// Mach-O / universal-binary magic numbers (read as the file's first 4 bytes).
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, // thin (32/64, both endians)
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca, // fat/universal (32/64)
]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function machOFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue; // sign concrete targets, never the symlinks
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && isMachO(p)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function discoverIdentity() {
  if (process.env.CANVAS_SIGN_IDENTITY) return process.env.CANVAS_SIGN_IDENTITY;
  const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const ids = [...out.matchAll(/"(Developer ID Application:[^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 1) return ids[0];
  throw new Error(
    `afterPack: expected exactly one "Developer ID Application" identity (found ${ids.length}). ` +
      `Set CANVAS_SIGN_IDENTITY to disambiguate.`,
  );
}

async function pool(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function signOne(file, identity) {
  try {
    execFileSync('xattr', ['-cr', file]); // strip quarantine / resource-fork junk
  } catch {
    /* best-effort */
  }
  await execFileP('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--entitlements', ENTITLEMENTS,
    '--sign', identity,
    file,
  ]);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const sidecars = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'sidecars');
  if (!fs.existsSync(sidecars)) {
    console.log('[afterPack] no Contents/Resources/sidecars — nothing to sign');
    return;
  }

  const identity = discoverIdentity();
  // Deepest-first so any nested code is signed before its container.
  const files = machOFiles(sidecars).sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  console.log(`[afterPack] signing ${files.length} Mach-O files under sidecars/ with: ${identity}`);

  await pool(files, 8, (f) => signOne(f, identity));

  // Re-sign the top-level executables last (defensive ordering).
  for (const leaf of ['ollama/ollama', 'ollama/llama-server', 'docling-serve/python/bin/python3']) {
    const p = path.join(sidecars, leaf);
    if (fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink() && isMachO(p)) await signOne(p, identity);
  }

  // Fail the build now (not at notarization) if anything is still ad-hoc/unsigned.
  for (const leaf of ['ollama/ollama', 'docling-serve/python/bin/python3']) {
    const p = path.join(sidecars, leaf);
    if (fs.existsSync(p)) {
      execFileSync('codesign', ['--verify', '--strict', p]);
      const out = execFileSync('codesign', ['-dvv', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (/adhoc/i.test(out)) throw new Error(`[afterPack] ${leaf} is still ad-hoc signed after signing`);
    }
  }
  console.log(`[afterPack] sidecar signing complete (${files.length} Mach-O, Developer-ID + hardened runtime)`);
};
