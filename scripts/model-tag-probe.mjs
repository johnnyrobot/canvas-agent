/**
 * The real, networked probe behind the shipped-model release gate (#40).
 *
 * It lives here, in release tooling, and NOT under `src/`: the app is on-device
 * only and nothing it ships may call a model API over the network. Every
 * DECISION the gate makes is pure and unit-tested in
 * `src/runtime/release-model-gate.ts` — including `manifestUrl`, which this file
 * imports rather than re-deriving, because a probe that computes its own URL is
 * a probe that can confidently fetch the wrong model. What is left here is
 * fetching, and only fetching.
 *
 * Two questions, two sources, because no single one answers both:
 *
 *   resolves     — the REGISTRY, by manifest fetch. This is the question the
 *                  local store cannot answer: an installed tag keeps working
 *                  long after its registry entry has been renamed out from under
 *                  the `ollama pull <tag>` recovery the app prints.
 *   capabilities — the LOCAL Ollama, via `/api/show`, which is the same source
 *                  the runtime's per-role capability check reads (ADR-0010), so
 *                  the gate and the app agree by construction. Ollama derives
 *                  these from the model's own weights metadata and no registry
 *                  publishes them, so this needs the tag pulled: a release box
 *                  that has never run the app fails here, loudly, which is the
 *                  correct outcome for a build nobody has smoked.
 *
 * Reading capabilities locally would prove nothing about the shipped tag on its
 * own — a tag is a mutable pointer, and this box may hold what it meant a year
 * ago. So both digests come back too: Ollama stores a local model under the
 * sha256 of its manifest, and that is exactly what hashing the registry's
 * manifest bytes yields, so an equal pair means the copy interrogated here IS
 * what a user will pull. The gate compares them.
 *
 * Every failure that is not a definitive "no" is thrown, never swallowed into a
 * `resolves: false` or an empty capability list — the gate fails closed on a
 * rejection, and a timeout dressed up as an answer would be the one way to make
 * an offline build pass.
 */
import { createHash } from 'node:crypto';

import { manifestUrl } from '../dist/runtime/release-model-gate.js';

const PROBE_TIMEOUT_MS = 15000;
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json, application/json';

/** Base URL of the local Ollama; `OLLAMA_HOST` is `host:port`, as Ollama itself writes it. */
function ollamaBase() {
  const host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
  return /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `http://${host}`;
}

/**
 * The manifest the registry serves for `tag`, as `{resolves, digest}`.
 *
 * "Gone" is host-specific and observed, not assumed: registry.ollama.ai answers
 * 404 for an unknown tag, while Hugging Face answers 401 for a repo that does
 * not exist and 400 for a quant that does not. Anything else — including an
 * ollama-registry 401, which would be an auth challenge rather than a
 * withdrawal — throws, so a healthy tag is never failed with the wrong
 * diagnosis and an unexpected answer is never read as a pass.
 */
async function fetchManifest(tag) {
  const url = manifestUrl(tag);
  const gone = new URL(url).host === 'huggingface.co' ? [400, 401, 403, 404] : [404];

  let res;
  try {
    res = await fetch(url, {
      headers: { accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`registry unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A tag that has become gated or private counts as gone, and not by leniency:
  // this probe is anonymous because `ollama pull <tag>` on a stranded user's
  // machine is anonymous, so a tag they cannot fetch is unresolvable in the only
  // sense that matters.
  if (gone.includes(res.status)) return { resolves: false, digest: '' };
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${url}`);

  // Ollama keys a local model by the sha256 of these exact bytes, so hash the
  // body rather than re-serializing the parsed JSON.
  return { resolves: true, digest: createHash('sha256').update(await res.bytes()).digest('hex') };
}

/** The digest of the local copy of `tag`, or `''` when it is not installed. */
async function localDigest(tag) {
  const data = await ollamaJson('/api/tags', undefined);
  const found = (data.models ?? []).find((m) => m.name === tag);
  // Ollama reports `sha256:<hex>`; the gate compares against a bare hex digest.
  return typeof found?.digest === 'string' ? found.digest.replace(/^sha256:/, '') : '';
}

/** What the local Ollama says this tag can do. Throws when it cannot say. */
async function localCapabilities(tag) {
  const data = await ollamaJson('/api/show', { model: tag });
  return Array.isArray(data.capabilities) ? data.capabilities.filter((c) => typeof c === 'string') : [];
}

/** GET/POST the local Ollama and parse JSON. Every failure throws — the gate needs an answer or a rejection. */
async function ollamaJson(route, body) {
  const url = `${ollamaBase()}${route}`;
  let res;
  try {
    res = await fetch(url, {
      ...(body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `local Ollama unreachable at ${url}: ${err instanceof Error ? err.message : String(err)} — start it (\`ollama serve\`) so capabilities can be read from the tag itself`,
    );
  }
  if (res.status === 404 && body?.model) {
    throw new Error(
      `${body.model} is not installed on this machine, so its capabilities cannot be read — \`ollama pull ${body.model}\` and re-run`,
    );
  }
  if (!res.ok) throw new Error(`Ollama ${route} returned ${res.status}`);
  return res.json();
}

/** @type {import('../dist/runtime/release-model-gate.js').ShippedTagProbe} */
export async function probeShippedTag(tag) {
  const registry = await fetchManifest(tag);
  // Short-circuit on a definitive no. A withdrawn tag is usually also absent
  // from the release box's store, and `/api/show` would then throw "not
  // installed" — burying the actual finding under a recovery instruction
  // (`ollama pull`) that cannot work either.
  if (!registry.resolves) return { resolves: false, capabilities: [], registryDigest: '', localDigest: '' };

  return {
    resolves: true,
    registryDigest: registry.digest,
    localDigest: await localDigest(tag),
    capabilities: await localCapabilities(tag),
  };
}
