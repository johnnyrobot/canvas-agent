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
 * The probe is injected for exactly that reason — the decision logic above is
 * pure and unit-tested offline; `scripts/model-tag-probe.mjs` supplies the real
 * network probe at packaging time, where it belongs. No module under `src/`
 * calls a model API over the network.
 */
import { loadLLMConfig } from '../llm/config.js';
import { REQUIRED_MODEL_ROLES, REQUIRED_ROLES, type RequiredModelRole } from '../llm/types.js';
import { runtimeLlmEnv } from './deps.js';

/** What a release-time probe reports about one shipped tag. */
export interface ShippedTagProbeResult {
  /** Whether the registry still serves it — i.e. `ollama pull <tag>` would work. */
  resolves: boolean;
  /** The capabilities the tag reports, named as Ollama's `/api/show` names them. */
  capabilities: readonly string[];
}

/** Answers both release-time questions about one tag. May reject; that fails the check. */
export type ShippedTagProbe = (tag: string) => Promise<ShippedTagProbeResult>;

/** One role's verdict, in the shape `scripts/pre-release.mjs` reports. */
export interface ShippedTagCheck {
  role: RequiredModelRole;
  tag: string;
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * Check every shipped default tag: it resolves, and it reports what its role
 * needs.
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

      const missing = spec.capabilities.filter((c) => !probed.capabilities.includes(c));
      if (missing.length > 0) {
        // Never a pull: the weights are fine, they just cannot do this job.
        return verdict(
          false,
          `INCAPABLE — reports [${probed.capabilities.join(', ') || 'nothing'}], and the ${role} role requires [${missing.join(', ')}]; point ${spec.envVar} at a tag that can`,
        );
      }

      return verdict(true, `resolves; reports [${probed.capabilities.join(', ')}]`);
    }),
  );
}
