/**
 * The real, networked probe behind the shipped-model release gate (#40).
 *
 * It lives here, in release tooling, and NOT under `src/`: the app is on-device
 * only and nothing it ships may call a model API over the network. The gate's
 * decision logic is pure and unit-tested in `src/runtime/release-model-gate.ts`
 * with this probe injected; this file is the half that has to leave the machine,
 * and it runs once, at packaging time, on the release box.
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
 *                  these from the model's own GGUF metadata and does not publish
 *                  them in the registry manifest, so this needs the tag pulled:
 *                  a release box that has never run the app fails here, loudly,
 *                  which is the correct outcome for a build nobody has smoked.
 *
 * Every failure that is not a definitive "no" is thrown, never swallowed into a
 * `resolves: false` or an empty capability list — the gate fails closed on a
 * rejection, and a timeout dressed up as an answer would be the one way to make
 * an offline build pass.
 */

const REGISTRY_TIMEOUT_MS = 15000;
const SHOW_TIMEOUT_MS = 15000;

/**
 * Where a tag's manifest lives. Mirrors how Ollama itself resolves a name:
 * `[host/][namespace/]name[:tag]`, defaulting to `registry.ollama.ai/library`
 * and `:latest`.
 *
 * The `hf.co/...` form is handled separately and deliberately: those tags are
 * not in the model library at all, and their upstream repo can be renamed or
 * withdrawn by its owner — which is the exposure that put this gate in the
 * release path. The check there is that the repo still exists.
 */
export function manifestUrl(tag) {
  const [ref, version = 'latest'] = splitVersion(tag);
  const parts = ref.split('/');
  const host = parts.length === 3 ? parts[0] : null;

  if (host === 'hf.co' || host === 'huggingface.co') {
    return `https://huggingface.co/api/models/${parts[1]}/${parts[2]}`;
  }
  const name = parts[parts.length - 1];
  const namespace = parts.length >= 2 ? parts[parts.length - 2] : 'library';
  const registry = host ?? 'registry.ollama.ai';
  return `https://${registry}/v2/${namespace}/${name}/manifests/${version}`;
}

/** Split `name:version`, tolerating the `host/ns/name` prefix (no colon in a host we support). */
function splitVersion(tag) {
  const i = tag.lastIndexOf(':');
  if (i < 0) return [tag];
  return [tag.slice(0, i), tag.slice(i + 1)];
}

/** Base URL of the local Ollama, matching how `src/llm/config.ts` reads the env. */
function ollamaBase(env = process.env) {
  const host = env.OLLAMA_HOST && env.OLLAMA_HOST !== '' ? env.OLLAMA_HOST : '127.0.0.1:11434';
  return /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `http://${host}`;
}

/** Does the registry still serve this tag? 404 is a definitive no; anything else unexpected throws. */
async function registryResolves(tag) {
  const url = manifestUrl(tag);
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json, application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`registry unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 404 is the plain "gone". 401/403 counts as gone too, and not by leniency:
  // the probe is anonymous because `ollama pull <tag>` on a stranded user's
  // machine is anonymous, so a tag that has become gated or private is exactly
  // as unreachable to them as a deleted one. (Hugging Face answers 401, not 404,
  // for a repo that does not exist — so this is also the only correct reading of
  // an `hf.co/...` default that has been renamed away.)
  if (res.status === 404 || res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${url}`);
  return true;
}

/** What the local Ollama says this tag can do. Throws when it cannot say. */
async function localCapabilities(tag, env = process.env) {
  const url = `${ollamaBase(env)}/api/show`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: tag }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `local Ollama unreachable at ${url}: ${err instanceof Error ? err.message : String(err)} — start it (\`ollama serve\`) so capabilities can be read from the tag itself`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `${tag} is not installed on this machine, so its capabilities cannot be read — \`ollama pull ${tag}\` and re-run`,
    );
  }
  if (!res.ok) throw new Error(`Ollama /api/show returned ${res.status} for ${tag}`);
  const data = await res.json();
  return Array.isArray(data.capabilities) ? data.capabilities.filter((c) => typeof c === 'string') : [];
}

/** @type {(tag: string) => Promise<{resolves: boolean, capabilities: string[]}>} */
export async function probeShippedTag(tag) {
  const resolves = await registryResolves(tag);
  // Short-circuit on a definitive no. A withdrawn tag is usually also absent
  // from the release box's store, and `/api/show` would then throw "not
  // installed" — burying the actual finding under a recovery instruction
  // (`ollama pull`) that cannot work either.
  if (!resolves) return { resolves, capabilities: [] };
  return { resolves, capabilities: await localCapabilities(tag) };
}
