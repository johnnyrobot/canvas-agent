import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatOptions, ChatResult } from '../llm/index.js';
import type {
  AllowlistResult,
  AuditIssue,
  Auditor,
  CanvasImportResult,
  GateDeps,
  IssueSet,
  KbResult,
  TurnChunk,
} from '../contracts/index.js';
import { validateAllowlist } from '../engine/index.js';
import type { ChatRunner } from '../orchestrator/index.js';
import { createInMemorySecretStore, migrate, openDatabase } from '../storage/index.js';
import type { SessionStore } from '../storage/index.js';
import { createAppApi } from './app-api.js';

/** A scripted model: returns queued responses, records what each call saw. */
class ScriptedRunner implements ChatRunner {
  systems: Array<string | undefined> = [];
  messagesSeen: ChatMessage[][] = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const sys = opts.messages.find((m: ChatMessage) => m.role === 'system');
    this.systems.push(typeof sys?.content === 'string' ? sys.content : undefined);
    this.messagesSeen.push(opts.messages);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedRunner exhausted');
    return next;
  }
}

/** Open a migrated in-memory DB (real stores, no file). */
async function freshDb() {
  const db = await openDatabase(':memory:');
  await migrate(db);
  return db;
}

/** A gate that flags issues by sentinel markers in the HTML (offline, deterministic). */
function markerGate(): GateDeps {
  return {
    validateAllowlist: async (html: string): Promise<AllowlistResult> => ({ html, removedSemantic: [] }),
    audit: async (html: string): Promise<IssueSet> => {
      const issues: AuditIssue[] = [];
      if (html.includes('LOWCONTRAST')) issues.push({ id: 'contrast', severity: 'blocker', message: 'low contrast' });
      if (html.includes('NOALT')) issues.push({ id: 'alt-text', severity: 'error', message: 'missing alt' });
      return { issues };
    },
  };
}

/** A gate that emits one blocker per 'X' in the HTML (drives the re-audit loop). */
function xGate(): GateDeps {
  return {
    validateAllowlist: async (html: string): Promise<AllowlistResult> => ({ html, removedSemantic: [] }),
    audit: async (html: string): Promise<IssueSet> => ({
      issues: [...html]
        .filter((ch) => ch === 'X')
        .map((_, i): AuditIssue => ({ id: `blk-${i}`, severity: 'blocker', message: 'residual issue' })),
    }),
  };
}

const cleanAudit: Auditor = async () => ({ issues: [] });
const text = (content: string): ChatResult => ({ content, model: 'm', raw: {} });
const callTool = (name: string, args: Record<string, unknown>): ChatResult => ({
  content: '', model: 'm', raw: {}, toolCalls: [{ name, arguments: args }],
});

const fakeLlm = { describeImage: async () => text('alt'), isHealthy: async () => true };
const fakeIngest = { convertPath: async () => ({ status: 'success', processingTimeMs: 1 }), isHealthy: async () => true };
const emptyRetriever = async (): Promise<KbResult> => ({ hits: [] });

function api(runner: ChatRunner, over: Partial<Parameters<typeof createAppApi>[0]> = {}) {
  return createAppApi({
    chatRunner: runner,
    llm: fakeLlm,
    ingest: fakeIngest,
    retriever: emptyRetriever,
    audit: cleanAudit,
    ...over,
  });
}

test('runTurn returns a TurnView (text, toolsUsed, iterations)', async () => {
  const runner = new ScriptedRunner([
    callTool('render_template', { type: 'page-content', slots: { title: 'Welcome' } }),
    text('Here is your page.'),
  ]);
  const view = await api(runner).runTurn({ user: 'make a welcome page' });
  assert.equal(view.text, 'Here is your page.');
  assert.equal(view.iterations, 2);
  assert.deepEqual(view.toolsUsed, ['render_template']);
});

test('runTurn gates a render_template fragment: passes checks + allowlist-clean', async () => {
  const runner = new ScriptedRunner([
    callTool('render_template', { type: 'page-content', slots: { title: 'Welcome', sections: [{ heading: 'Intro', body: 'Hello' }] } }),
    text('done'),
  ]);
  const view = await api(runner).runTurn({ user: 'build it' });
  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.conformance.passedChecks, true);
  assert.equal(frag.gate.badgeWithheld, false);
  // allowlist-clean = the gated HTML survives the allowlist unchanged, no semantic loss.
  const re = await validateAllowlist(frag.html);
  assert.deepEqual(re.removedSemantic, []);
  assert.equal(re.html, frag.html);
});

test('runTurn withholds the badge for a deliberately bad fenced fragment', async () => {
  // <figure>/<figcaption> are semantic but off the Canvas allowlist → removed → blocker.
  const bad = 'Sure:\n\n```html\n<figure><img src="https://x/y.png" alt="y"><figcaption>cap</figcaption></figure>\n```\n';
  const runner = new ScriptedRunner([text(bad)]);
  const view = await api(runner).runTurn({ user: 'give me html' });
  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.badgeWithheld, true);
  assert.equal(frag.gate.conformance.passedChecks, false);
  assert.ok(frag.gate.conformance.blockers.some((b) => b.id.startsWith('allowlist-removed-semantic')));
});

test('a prose conformance claim is LABELLED (not asserted) and never implies a badge', async () => {
  // Model asserts conformance in prose AND emits a blocker-triggering fragment
  // (<figure>/<figcaption> are off the Canvas allowlist → removed → blocker).
  const bad =
    'This page is WCAG 2.2 AA certified.\n\n```html\n<figure><img src="https://x/y.png" alt="y"><figcaption>cap</figcaption></figure>\n```\n';
  const runner = new ScriptedRunner([text(bad)]);
  const view = await api(runner).runTurn({ user: 'is it accessible?' });

  // The authoritative signal — the gate badge — is correctly withheld.
  assert.equal(view.fragments[0]?.gate.badgeWithheld, true);
  // The prose is labelled non-authoritative; the claim itself is preserved, not scrubbed.
  assert.match(view.text, /badge|authoritative|not a verified/i, 'conformance claim must be labelled');
  assert.ok(view.text.includes('WCAG 2.2 AA certified'), 'the author claim is preserved (labelled, not deleted)');
});

test('ordinary prose with no conformance claim is left untouched', async () => {
  const runner = new ScriptedRunner([text('Here is a friendly welcome message for your students.')]);
  const view = await api(runner).runTurn({ user: 'write a welcome note' });
  assert.equal(view.text, 'Here is a friendly welcome message for your students.');
});

test('runTurn grounds the system prompt with retrieved Knowledge-Pack citations', async () => {
  const runner = new ScriptedRunner([text('answer')]);
  const retriever = async (): Promise<KbResult> => ({
    hits: [{ id: 'p:1', packId: 'p', title: 't', snippet: 'Use scope on header cells.', score: 1, citation: 'WCAG H51' }],
  });
  await api(runner, { retriever, systemPrompt: 'HARD RULES' }).runTurn({ user: 'accessible tables?' });
  const sys = runner.systems[0];
  assert.ok(sys?.includes('WCAG H51'), 'citation grounded into the system prompt');
  assert.ok(sys?.includes('HARD RULES'), 'base hard rules preserved');
});

test('runTurn lets the caller override the system prompt', async () => {
  const runner = new ScriptedRunner([text('answer')]);
  await api(runner).runTurn({ user: 'hi', system: 'CUSTOM PROMPT' });
  assert.equal(runner.systems[0], 'CUSTOM PROMPT');
});

test('toolsUsed is de-duplicated by name', async () => {
  const runner = new ScriptedRunner([
    callTool('audit_html', { html: '<p>a</p>' }),
    callTool('audit_html', { html: '<p>b</p>' }),
    text('done'),
  ]);
  const view = await api(runner).runTurn({ user: 'audit twice' });
  assert.deepEqual(view.toolsUsed, ['audit_html']);
});

test('a truncated final draft (doneReason="length") is flagged incomplete in view.text (C11)', async () => {
  const runner = new ScriptedRunner([
    { content: 'Here is the first half of your page', model: 'm', raw: {}, doneReason: 'length' },
  ]);
  const view = await api(runner).runTurn({ user: 'write a long page' });
  assert.match(view.text, /cut off|incomplete|output limit/i, 'truncation must be surfaced');
  assert.ok(view.text.includes('first half of your page'), 'original draft text is preserved after the notice');
});

test('a normally-finished draft (doneReason="stop") carries no truncation notice', async () => {
  const runner = new ScriptedRunner([{ content: 'All done.', model: 'm', raw: {}, doneReason: 'stop' }]);
  const view = await api(runner).runTurn({ user: 'hi' });
  assert.equal(view.text, 'All done.');
});

test('health() reports per-sidecar reachability and never throws', async () => {
  const runner = new ScriptedRunner([]);
  const view = api(runner, {
    llm: { describeImage: async () => text('x'), isHealthy: async () => true },
    ingest: { convertPath: async () => ({ status: 'failure', processingTimeMs: 0 }), isHealthy: async () => { throw new Error('down'); } },
  });
  const health = await view.health();
  assert.deepEqual(health, { llm: true, ingest: false });
});

test('importCanvas delegates to the injected importer', async () => {
  const runner = new ScriptedRunner([]);
  const expected: CanvasImportResult = {
    courseId: '42', name: 'Bio 101', importedAt: '2026-01-01T00:00:00Z',
    pages: 3, assignments: 2, files: 1, warnings: [],
  };
  let seen: { baseUrl: string; token: string; courseId: string } | undefined;
  const view = api(runner, {
    db: await freshDb(), // importCanvas now records provenance — keep it off the real on-device DB
    secrets: createInMemorySecretStore(),
    importer: async (config, courseId) => {
      seen = { baseUrl: config.baseUrl, token: config.token, courseId };
      return expected;
    },
  });
  await view.saveCanvasAuth({ baseUrl: 'https://canvas.test', token: 't' });
  const res = await view.importCanvas('https://canvas.test', '42');
  assert.deepEqual(res, expected);
  // The importer received the token resolved from the keychain, not from the renderer.
  assert.deepEqual(seen, { baseUrl: 'https://canvas.test', token: 't', courseId: '42' });
});

test('importCanvas records a provenance row in canvas_imports (L6)', async () => {
  const db = await freshDb();
  const expected: CanvasImportResult = {
    courseId: '7', name: 'Chem 200', importedAt: '2026-02-02T00:00:00Z',
    pages: 5, assignments: 4, files: 2, warnings: ['heads up'],
  };
  const view = api(new ScriptedRunner([]), {
    db,
    secrets: createInMemorySecretStore(),
    importer: async () => expected,
  });
  await view.saveCanvasAuth({ baseUrl: 'https://canvas.test', token: 't' });
  await view.importCanvas('https://canvas.test', '7');

  const row = await db.get<{ name: string; imported_at: string; summary_json: string }>(
    'SELECT name, imported_at, summary_json FROM canvas_imports WHERE course_id = ?',
    ['7'],
  );
  assert.equal(row?.name, 'Chem 200');
  assert.equal(row?.imported_at, '2026-02-02T00:00:00Z');
  assert.deepEqual(JSON.parse(row!.summary_json), { pages: 5, assignments: 4, files: 2, warnings: ['heads up'] });
});

test('importCanvas still resolves when the provenance write fails (best-effort DB)', async () => {
  const expected: CanvasImportResult = {
    courseId: '7', name: 'Chem 200', importedAt: '2026-02-02T00:00:00Z',
    pages: 5, assignments: 4, files: 2, warnings: [],
  };
  // A DB whose run() always rejects (locked DB / disk full). The completed import
  // must NOT be discarded by a provenance bookkeeping failure.
  const rejectingDb = {
    exec: async () => {},
    all: async () => [],
    get: async () => undefined,
    run: async () => { throw new Error('database is locked'); },
    close: async () => {},
  };
  const view = api(new ScriptedRunner([]), {
    db: rejectingDb,
    secrets: createInMemorySecretStore(),
    importer: async () => expected,
  });
  await view.saveCanvasAuth({ baseUrl: 'https://canvas.test', token: 't' });
  const res = await view.importCanvas('https://canvas.test', '7');
  assert.deepEqual(res, expected, 'import result is returned despite the provenance write failing');
});

// ── Mode routing + streaming ─────────────────────────────────────────────────

test('runTurn echoes the routed mode (build keywords → build; default → guidance; override wins)', async () => {
  const build = await api(new ScriptedRunner([text('ok')])).runTurn({ user: 'create a syllabus page' });
  assert.equal(build.mode, 'build');

  const guidance = await api(new ScriptedRunner([text('ok')])).runTurn({ user: 'tell me about headings' });
  assert.equal(guidance.mode, 'guidance');

  const overridden = await api(new ScriptedRunner([text('ok')])).runTurn({ user: 'create a page', mode: 'guidance' });
  assert.equal(overridden.mode, 'guidance');
});

test('runTurn uses the per-mode system prompt by default', async () => {
  const runner = new ScriptedRunner([text('ok')]);
  await api(runner).runTurn({ user: 'create a syllabus page' }); // → build
  assert.ok(runner.systems[0]?.includes('Mode: BUILD'), 'build mode prompt assembled');
});

test('runTurn streams tool, text, and fragment chunks to onChunk', async () => {
  const runner = new ScriptedRunner([
    callTool('render_template', { type: 'page-content', slots: { title: 'Welcome', sections: [{ heading: 'Intro', body: 'Hello' }] } }),
    text('done'),
  ]);
  const chunks: TurnChunk[] = [];
  const view = await api(runner).runTurn({ user: 'build a page' }, (c) => chunks.push(c));

  assert.ok(chunks.some((c) => c.type === 'tool' && c.name === 'render_template'), 'tool chunk streamed');
  assert.ok(chunks.some((c) => c.type === 'text' && c.delta === 'done'), 'text chunk streamed');
  assert.ok(chunks.some((c) => c.type === 'fragment'), 'fragment chunk streamed');
  assert.equal(view.fragments.length, 1);
});

// ── Sessions (real in-memory store + persistence) ────────────────────────────

test('sessions: create / list / load / delete round-trip', async () => {
  const db = await freshDb();
  const app = api(new ScriptedRunner([]), { db });

  const s = await app.createSession({ title: 'My chat', mode: 'build' });
  assert.equal(s.title, 'My chat');
  assert.equal(s.mode, 'build');

  const list = await app.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, s.id);

  const loaded = await app.loadSession(s.id);
  assert.equal(loaded?.session.id, s.id);
  assert.deepEqual(loaded?.messages, []);

  await app.deleteSession(s.id);
  assert.equal((await app.listSessions()).length, 0);
  assert.equal(await app.loadSession(s.id), null);
});

test('a turn with sessionId persists user+assistant and replays them as history', async () => {
  const db = await freshDb();
  const runner = new ScriptedRunner([text('first answer'), text('second answer')]);
  const app = api(runner, { db });
  const s = await app.createSession({ title: 'chat', mode: 'guidance' });

  await app.runTurn({ user: 'hello', sessionId: s.id });
  const after1 = await app.loadSession(s.id);
  assert.deepEqual(after1?.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'first answer' },
  ]);

  await app.runTurn({ user: 'again', sessionId: s.id });
  // The second model call must have seen the prior turn replayed as history.
  const seen = runner.messagesSeen[1] ?? [];
  assert.ok(seen.some((m) => m.role === 'user' && m.content === 'hello'), 'prior user replayed');
  assert.ok(seen.some((m) => m.role === 'assistant' && m.content === 'first answer'), 'prior assistant replayed');

  const after2 = await app.loadSession(s.id);
  assert.equal(after2?.messages.length, 4);
});

test('a Build turn persists its gated fragment so a reload restores the work product (C10)', async () => {
  const db = await freshDb();
  const runner = new ScriptedRunner([
    callTool('render_template', {
      type: 'page-content',
      slots: { title: 'Welcome', sections: [{ heading: 'Intro', body: 'Hello' }] },
    }),
    text('Here is your page.'),
  ]);
  const app = api(runner, { db });
  const s = await app.createSession({ title: 'build', mode: 'build' });

  const view = await app.runTurn({ user: 'build a page', sessionId: s.id, mode: 'build' });
  assert.ok(view.fragments.length > 0, 'the turn produced a gated fragment');

  // Reloading the session must restore the gated HTML + badge, not just the prose.
  const reloaded = await app.loadSession(s.id);
  const assistant = reloaded?.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant?.fragments && assistant.fragments.length > 0, 'fragments restored on reload');
  assert.deepEqual(assistant.fragments, view.fragments, 'restored fragment matches what was produced');
});

test('session methods honor an injected sessionStore (override seam)', async () => {
  let createdWith: { title: string; mode: string } | undefined;
  const store: SessionStore = {
    createSession: async (init) => { createdWith = init; return { id: 'sx', title: init.title, mode: init.mode, createdAt: 't', updatedAt: 't' }; },
    listSessions: async () => [],
    loadSession: async () => null,
    appendMessages: async () => {},
    deleteSession: async () => {},
  };
  const app = api(new ScriptedRunner([]), { sessionStore: store });
  const s = await app.createSession({ title: 'x', mode: 'build' });
  assert.equal(s.id, 'sx');
  assert.deepEqual(createdWith, { title: 'x', mode: 'build' });
});

// ── Brand kits + theme (pure engine math; no LLM) ────────────────────────────

test('brand kits: save / list / delete round-trip', async () => {
  const db = await freshDb();
  const app = api(new ScriptedRunner([]), { db });

  const saved = await app.saveBrandKit({ name: 'Brand', palette: { primary: '#0a0a0a', secondary: '#ffffff' } });
  assert.ok(saved.id);
  assert.ok(saved.createdAt);
  assert.equal(saved.name, 'Brand');

  const list = await app.listBrandKits();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, saved.id);

  await app.deleteBrandKit(saved.id);
  assert.equal((await app.listBrandKits()).length, 0);
});

test('resolveBrandTheme uses the real theme resolver (AA-safe; no model call)', async () => {
  const runner = new ScriptedRunner([]); // never called
  const theme = await api(runner).resolveBrandTheme('#0a0a0a', '#ffffff');
  assert.ok(theme.colors.length > 0);
  for (const c of theme.colors) assert.equal(c.contrast.passesAA, true);
});

test('resolveBrandTheme honors an injected resolver (override seam)', async () => {
  let seen: { p: string; s: string } | undefined;
  const app = api(new ScriptedRunner([]), {
    resolveTheme: async (p, s) => { seen = { p, s }; return { colors: [], warnings: ['stub'] }; },
  });
  const t = await app.resolveBrandTheme('#111111', '#222222');
  assert.deepEqual(seen, { p: '#111111', s: '#222222' });
  assert.deepEqual(t.warnings, ['stub']);
});

// ── Read-only Canvas page access ─────────────────────────────────────────────

test('fetchCanvasPage / listCanvasPages delegate to the injected readers (token from keychain)', async () => {
  const app = api(new ScriptedRunner([]), {
    secrets: createInMemorySecretStore(),
    fetchPageBody: async (cfg, courseId, pageId) => `body:${cfg.baseUrl}:${cfg.token}:${courseId}:${pageId}`,
    listPages: async () => [{ id: 'p1', title: 'Page 1' }],
  });
  await app.saveCanvasAuth({ baseUrl: 'https://canvas.test', token: 'tok' });
  // Read calls take only the baseUrl; the runtime injects the keychain token.
  assert.equal(await app.fetchCanvasPage('https://canvas.test', '7', 'intro'), 'body:https://canvas.test:tok:7:intro');
  assert.deepEqual(await app.listCanvasPages('https://canvas.test', '7'), [{ id: 'p1', title: 'Page 1' }]);
});

test('a Canvas read without saved credentials is refused — no tokenless call (C7)', async () => {
  let called = false;
  const app = api(new ScriptedRunner([]), {
    secrets: createInMemorySecretStore(),
    fetchPageBody: async () => {
      called = true;
      return '';
    },
  });
  await assert.rejects(
    () => app.fetchCanvasPage('https://canvas.test', '7', 'intro'),
    /credential|saveCanvasAuth/i,
  );
  assert.equal(called, false, 'the reader must not be called without a resolved token');
});

// ── Remediate flow ───────────────────────────────────────────────────────────

test('remediate diffs issues by id (fixed = gone after), emits one fragment, never touches Canvas', async () => {
  const source = '<p class="LOWCONTRAST"><img alt="" data-x="NOALT"></p>';
  const fixed = '<p data-x="NOALT">repaired, but alt still missing</p>';
  // The model fixes the contrast blocker but cannot fix the missing alt (a serious
  // AA failure). Post-C2 that residual `error` keeps the badge withheld, so the
  // bounded re-audit loop runs one retry (which fails to improve, then breaks) —
  // hence two scripted repair responses.
  const repaired = text('```html\n' + fixed + '\n```');
  const runner = new ScriptedRunner([repaired, repaired]);
  let canvasCalls = 0;
  const chunks: TurnChunk[] = [];

  const view = await api(runner, {
    gate: markerGate(),
    fetchPageBody: async () => { canvasCalls++; return ''; },
    listPages: async () => { canvasCalls++; return []; },
  }).runTurn(
    { user: 'fix my page', mode: 'remediate', remediateInput: { sourceHtml: source } },
    (c) => chunks.push(c),
  );

  assert.equal(view.mode, 'remediate');
  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  const rr = frag.remediateResult;
  assert.ok(rr, 'fragment carries a RemediateResult');
  assert.equal(rr!.before, source);
  assert.equal(rr!.after, fixed);
  assert.equal(
    rr!.gate.badgeWithheld,
    true,
    'contrast fixed, but the residual missing-alt (serious AA failure) still withholds the badge',
  );

  const fixedById = Object.fromEntries(rr!.issueDiffs.map((d) => [d.issue.id, d.fixed]));
  assert.equal(fixedById['contrast'], true, 'contrast blocker fixed');
  assert.equal(fixedById['alt-text'], false, 'alt-text issue still present');

  assert.ok(chunks.some((c) => c.type === 'fragment'), 'one fragment chunk streamed');
  assert.equal(canvasCalls, 0, 'remediate is GET-only; it never reads/writes Canvas');
});

test("remediate's re-audit loop is bounded to 3 passes and stops at the cap", async () => {
  // xGate emits one blocker per 'X'; the model strips one X per turn but never
  // reaches zero, so the loop must stop at the cap (initial + 3 re-audits).
  const runner = new ScriptedRunner([
    text('```html\n<p>XXXXXX</p>\n```'), // initial repair: 6
    text('```html\n<p>XXXXX</p>\n```'), // re-audit 1: 5
    text('```html\n<p>XXXX</p>\n```'), // re-audit 2: 4
    text('```html\n<p>XXX</p>\n```'), // re-audit 3: 3 (a 5th call would throw "exhausted")
  ]);
  const view = await api(runner, { gate: xGate() }).runTurn({
    user: 'repair this',
    mode: 'remediate',
    remediateInput: { sourceHtml: '<p>XXXXXXX</p>' }, // 7 issues
  });

  assert.equal(view.iterations, 4, 'initial repair + 3 capped re-audits');
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.badgeWithheld, true, 'still has blockers after the cap');
  assert.equal(frag.remediateResult!.after, '<p>XXX</p>', 'stopped at the 3-pass cap');
});

test('a residual blocker still withholds the badge in remediate mode (gate stays unconditional)', async () => {
  // The model returns HTML that still trips the blocker; the gate withholds.
  const runner = new ScriptedRunner([
    text('```html\n<p>XX</p>\n```'),
    text('```html\n<p>XX</p>\n```'), // re-audit returns no improvement → loop stops
  ]);
  const view = await api(runner, { gate: xGate() }).runTurn({
    user: 'repair this',
    mode: 'remediate',
    remediateInput: { sourceHtml: '<p>XXX</p>' },
  });
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.badgeWithheld, true);
  assert.equal(frag.gate.conformance.passedChecks, false);
});
