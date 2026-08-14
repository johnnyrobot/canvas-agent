/**
 * The release-time gate on the model tags this app ships as defaults (#40).
 *
 * Two things can be true of a shipped default that no offline declaration can
 * see, and both have already broken this product once:
 *
 *   1. The tag no longer RESOLVES. A model tag is a pointer into someone else's
 *      registry, renameable and withdrawable after we ship. When it goes, every
 *      recovery instruction the app prints — `ollama pull <tag>` — points at
 *      nothing, so a stranded user has no way back. (`granite-vision-4.1-4b`
 *      404s on registry.ollama.ai to this day; a handoff named it anyway.)
 *   2. The tag resolves, pulls perfectly, and cannot do the job. That is exactly
 *      how the flagship alt-text path broke: the vision role inherited
 *      `granite4.1:8b`, which reports `completion, tools` and no `vision`, and
 *      every screen read ready until the first image returned a 400.
 *
 * The licence / download-size / third-party-notice guards in `deps.test.ts` are
 * declarations checked against declarations: they prove the repo is internally
 * consistent, and cannot prove anything about the registry. This is the check
 * that leaves the repo — so it is the one check here that needs a network, and
 * therefore the one that must fail CLOSED. An unanswerable probe is a failed
 * check, never a skipped one: "we could not tell" and "it is fine" are the same
 * output only to a gate that has stopped being a gate.
 *
 * The probe is injected for exactly that reason — every decision below is pure
 * and unit-tested offline, including where a tag's manifest lives, which is the
 * single point at which the gate could probe the wrong URL and pass on a
 * confident 200 from something that is not the shipped model. Only the fetching
 * lives outside, in `scripts/model-tag-probe.mjs`, where release tooling
 * belongs: no module under `src/` calls a model API over the network.
 */
import { loadLLMConfig } from '../llm/config.js';
import { missingCapabilities, REQUIRED_MODEL_ROLES, REQUIRED_ROLES, type RequiredModelRole } from '../llm/types.js';
import { runtimeLlmEnv } from './deps.js';

/** What a release-time probe reports about one shipped tag. */
export interface ShippedTagProbeResult {
  /** Whether the registry still serves it — i.e. `ollama pull <tag>` would work. */
  resolves: boolean;
  /**
   * The capabilities the tag reports, named as Ollama's `/api/show` names them.
   *
   * Necessarily read from a LOCAL copy: capabilities are derived from the
   * model's own weights metadata and no registry publishes them. `localDigest`
   * is what makes that reading evidence about the shipped tag rather than about
   * one machine.
   */
  capabilities: readonly string[];
  /** Digest of the manifest the registry serves right now (`''` when it serves none). */
  registryDigest: string;
  /** Digest of the local copy `capabilities` was read from (`''` when there is none). */
  localDigest: string;
}

/** Answers the release-time questions about one tag. May reject; that fails the check. */
export type ShippedTagProbe = (tag: string) => Promise<ShippedTagProbeResult>;

/** One role's verdict, in the shape `scripts/pre-release.mjs` reports. */
export interface ShippedTagCheck {
  role: RequiredModelRole;
  tag: string;
  ok: boolean;
  label: string;
  detail: string;
}

/** Registries this app's tags can name, and where their manifests are served. */
const REGISTRY_HOSTS: Readonly<Record<string, string>> = {
  'hf.co': 'huggingface.co',
  'huggingface.co': 'huggingface.co',
};

const DEFAULT_REGISTRY = 'registry.ollama.ai';

/**
 * Where a tag's manifest lives — pure, so the gate cannot quietly probe the
 * wrong thing.
 *
 * Mirrors how Ollama itself resolves a name, `[host/][namespace/]name[:version]`,
 * defaulting to `registry.ollama.ai/library` and `:latest`. Hugging Face serves
 * the same Docker-v2 manifest route (`huggingface.co/v2/<owner>/<repo>/manifests/<quant>`),
 * so an `hf.co/...` default is checked at the QUANT, which is what `ollama pull`
 * actually fetches — checking the repo alone would wave through a withdrawn
 * quant sitting inside a repo that still exists.
 */
export function manifestUrl(tag: string): string {
  const colon = tag.lastIndexOf(':');
  const ref = colon < 0 ? tag : tag.slice(0, colon);
  const version = colon < 0 ? 'latest' : tag.slice(colon + 1);

  const parts = ref.split('/');
  const named = parts.length === 3 ? REGISTRY_HOSTS[parts[0]!] : undefined;
  const registry = named ?? DEFAULT_REGISTRY;
  const name = parts[parts.length - 1]!;
  const namespace = parts.length >= 2 ? parts[parts.length - 2]! : 'library';

  return `https://${registry}/v2/${namespace}/${name}/manifests/${version}`;
}

/**
 * Check every shipped default tag: it resolves, the copy we can interrogate is
 * the one the registry serves, and it reports what its role needs.
 *
 * Deliberately walks `REQUIRED_MODEL_ROLES` rather than the runtime's *required
 * set*. The required set is narrowed by configuration — `LLM_VISION_ENABLED=false`
 * drops the vision role (ADR-0010) — and that is right for a runtime answering
 * "what must this machine download?" and wrong for a release answering "what am
 * I about to ship to everyone?". The DMG carries both defaults whatever the
 * packaging machine has exported, so both are checked. The tags come from
 * `runtimeLlmEnv({})`, the same injection the app ships with, so a default swap
 * re-points this gate automatically.
 */
export async function checkShippedModelTags(probe: ShippedTagProbe): Promise<ShippedTagCheck[]> {
  const config = loadLLMConfig(runtimeLlmEnv({}));

  return Promise.all(
    REQUIRED_MODEL_ROLES.map(async (role) => {
      const spec = REQUIRED_ROLES[role];
      const tag = config.models[role];
      const label = `shipped ${role} default resolves & reports [${spec.capabilities.join(', ')}]: ${tag}`;
      const verdict = (ok: boolean, detail: string): ShippedTagCheck => ({ role, tag, ok, label, detail });

      let probed: ShippedTagProbeResult;
      try {
        probed = await probe(tag);
      } catch (err) {
        // Offline, DNS down, daemon not running: unknown, therefore failed.
        return verdict(
          false,
          `UNCHECKABLE (${err instanceof Error ? err.message : String(err)}) — a shipped default that cannot be verified must not be packaged; restore the network / start Ollama and re-run`,
        );
      }

      if (!probed.resolves) {
        return verdict(
          false,
          `DOES NOT RESOLVE — the registry no longer serves this tag, so \`ollama pull ${tag}\` (the recovery this app prints to a stranded user) would fail; point ${spec.envVar} at a tag that resolves`,
        );
      }

      if (probed.localDigest !== probed.registryDigest) {
        // The capability reading below would otherwise describe whatever this
        // box happens to hold. A tag is a mutable pointer: the copy here may be
        // what the tag meant months ago, and its capabilities say nothing about
        // what a user will pull today.
        return verdict(
          false,
          `STALE LOCAL COPY — capabilities were read from ${probed.localDigest.slice(0, 12) || '(nothing)'}, but the registry now serves ${probed.registryDigest.slice(0, 12)}; \`ollama pull ${tag}\` to refresh, then re-run`,
        );
      }

      const missing = missingCapabilities(role, probed.capabilities);
      if (missing.length > 0) {
        // Never a pull: the weights are fine, they just cannot do this job.
        return verdict(
          false,
          `INCAPABLE — reports [${probed.capabilities.join(', ') || 'nothing'}], and the ${role} role requires [${missing.join(', ')}]; point ${spec.envVar} at a tag that can`,
        );
      }

      return verdict(
        true,
        `resolves as ${probed.registryDigest.slice(0, 12)}; reports [${probed.capabilities.join(', ')}]`,
      );
    }),
  );
}
