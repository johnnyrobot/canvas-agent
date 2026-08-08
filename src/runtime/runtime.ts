/**
 * `createRuntime` — the composition root that OWNS process lifetimes (ADR-0006).
 *
 * `createAppApi` used to construct the Ollama and Docling sidecars itself and
 * return an `AppApi`, which has no lifecycle members — so the two processes were
 * owned by a closure nothing outside could reach, and quitting the app orphaned
 * them (#13). Construction moves up one level to here, and the references stay
 * in scope so `dispose()` can stop them.
 *
 * `dispose` is NOT on `AppApi` on purpose: putting it there would trip the
 * growth law (a `CHANNELS` entry plus a `bridge.ts` handler) and make app
 * shutdown a renderer capability.
 */
import type { AppApi } from '../contracts/index.js';
import type { ChatRunner } from '../orchestrator/index.js';
import { createOllamaSidecar } from '../llm/index.js';
import { createDoclingSidecar } from '../ingest/index.js';
import { createAppApi, type AppApiOptions, type IngestRuntime, type LlmRuntime } from './app-api.js';
import { createActivityTracker, type ActivityTracker } from './activity.js';
import { createLazyDatabase, type LazyDatabase } from './database.js';
import { runtimeLlmEnv } from './deps.js';

/** How long an in-flight turn gets to settle before the sidecars are signalled. */
export const DRAIN_TIMEOUT_MS = 3_000;

/** The LLM sidecar as this root uses it: model, vision, health — and stoppable. */
export type OwnedLlm = LlmRuntime & ChatRunner & { stop(): Promise<void> };
/** The Docling sidecar as this root uses it: conversion, health — and stoppable. */
export type OwnedIngest = IngestRuntime & { stop(): Promise<void> };

export interface RuntimeHandle {
  api: AppApi;
  /** Drain, then stop everything this root owns. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * `database`, `activity`, `llm`, and `ingest` are omitted from the base options
 * because this root OWNS those four lifetimes: it supplies them to `createAppApi`
 * itself, built via `createDatabase` / `createActivity` / `createLlm` /
 * `createIngest` below. Accepting them directly here as well would silently
 * discard a caller-supplied instance (later object-literal keys win in the
 * `createAppApi({ ...appOptions, llm, ingest, database, activity })` call),
 * leaving that instance never opened/closed/stopped and never drained — no type
 * error, no runtime error, just a leak. For `llm`/`ingest` this is worse than a
 * leak: the discarded fake falls through to this root's own default, which
 * spawns a REAL `createOllamaSidecar()` / `createDoclingSidecar()` process, so a
 * test written as `createRuntime({ llm: fakeLlm })` would silently launch a real
 * `ollama serve` instead of using the fake. Making all four unavailable on this
 * type turns that mistake into a compile error instead of a documentation note.
 */
export interface CreateRuntimeOptions
  extends Omit<AppApiOptions, 'database' | 'activity' | 'llm' | 'ingest'> {
  /** Test seam: build the owned LLM sidecar. Default: a real `OllamaSidecar`. */
  createLlm?: () => OwnedLlm;
  /** Test seam: build the owned Docling sidecar. Default: a real `DoclingSidecar`. */
  createIngest?: () => OwnedIngest;
  /** Test seam: build the owned lazy database. Default: the real on-device one. */
  createDatabase?: () => LazyDatabase;
  /** Test seam: build the turn-activity tracker. Default: a real counting tracker. */
  createActivity?: () => ActivityTracker;
  /** Where teardown failures are reported. Default: console.warn. */
  log?: (msg: string) => void;
}

export function createRuntime(options: CreateRuntimeOptions = {}): RuntimeHandle {
  const { createLlm, createIngest, createDatabase, createActivity, log: logOverride, ...appOptions } = options;
  const log = logOverride ?? ((msg: string) => console.warn(msg));

  const llm: OwnedLlm = createLlm
    ? createLlm()
    : createOllamaSidecar({ env: runtimeLlmEnv(options.llmEnv) });
  const ingest: OwnedIngest = createIngest ? createIngest() : createDoclingSidecar();
  const database = createDatabase ? createDatabase() : createLazyDatabase();
  const activity = createActivity ? createActivity() : createActivityTracker();

  // `chatRunner` and `llm` are deliberately the SAME object — that is the
  // production wiring `createAppApi` did internally (one local model, one user).
  // `dispose` must therefore stop it ONCE.
  const api = createAppApi({
    ...appOptions,
    chatRunner: appOptions.chatRunner ?? llm,
    llm,
    ingest,
    database,
    activity,
  });

  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposing ??= (async () => {
      // Let an in-flight turn settle first: it owns a per-turn Chromium
      // (ADR-0005) disposed by its own `finally`. Bounded — a turn that will not
      // settle must not block quit.
      const drained = await activity.whenIdle(DRAIN_TIMEOUT_MS);
      if (!drained) {
        log(`[shutdown] a turn was still in flight after ${DRAIN_TIMEOUT_MS}ms; stopping anyway.`);
      }
      // allSettled, not all: a docling that fails to stop must not prevent
      // Ollama — the far larger leak — from being signalled.
      const results = await Promise.allSettled([llm.stop(), ingest.stop(), database.close()]);
      const labels = ['ollama', 'docling', 'database'] as const;
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          log(`[shutdown] ${labels[i]} did not stop cleanly: ${reason}`);
        }
      });
    })());

  return { api, dispose };
}
