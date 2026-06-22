# Canvas (Instructure) Instructor-Guide Retrieval — Empirical Findings

Date: 2026-06-02. All probes run with plain `curl` from the CLI. Raw evidence in `evidence/`.

## Step 1 — What programmatic access exists

**The premise that the Community runs on Khoros/Aurora is outdated.** As of this test,
`community.canvaslms.com` 301-redirects to `community.instructure.com`, which is served behind
**Cloudflare** and runs on **Higher Logic Vanilla** (formerly Vanilla Forums), NOT Khoros.

Two distinct access layers:

| Layer | Result |
|---|---|
| HTML pages (`/`, `/en/all-guides`, `/t5/...`, `/kb/sitemap-index.xml`) | **403 — Cloudflare JS challenge** (`cf-mitigated: challenge`). Scraping is blocked. |
| **Vanilla REST API `/api/v2/*`** | **200 — open JSON, no auth, no API key.** This is the usable channel. |

Relevant API endpoints (all public, verified):
- `GET /api/v2/knowledge-bases` — lists every guide as a "knowledge base"
- `GET /api/v2/articles?knowledgeBaseID=39&page=N&limit=M` — paginated article list (RFC5988 `Link` + `x-app-page-*` headers)
- `GET /api/v2/articles/{id}` — one full article (`body` HTML, `bodyPlainText`, `excerpt`, `outline`)
- `GET /api/v2/search?query=...&knowledgeBaseID=39&recordTypes[]=article&locale=en&limit=5` — **lexical search**

The **Canvas LMS Instructor Guide = knowledge base ID 39 (`canvas-lms-instructor-guide`), 638 articles.**
(Sibling KBs: 37 Basics, 40 Student, 42 Admin, 38 Troubleshooting, etc.)

NOTE on the connected `canvas-lms` MCP (646 tools): that is the Canvas **REST API** (course/quiz/page
CRUD) the user explicitly excluded. It carries no instructor-guide content and was not used here.

## Step 2 — Retrieval quality (4 real queries, KB 39, locale=en, limit=5)

Format: clean **JSON array**. Latency **75–405 ms** (8-request burst: 258–431 ms, all 200, no throttling,
no rate-limit headers). Each result includes `name`, `url`, `body` (HTML), `bodyPlainText`,
`highlight` (matched-term snippet), and `searchScore` (relevance rank).

| Query | Top hit | On-target? | Top-hit size (plaintext) |
|---|---|---|---|
| how do I create an accessible quiz | "How do I create a Hot Spot question in New Quizzes?" | **No** — no accessibility article surfaced; matched on "create/quiz" | 9,192 ch ≈ 2,300 tok |
| add alt text to images in a page | "How do I embed an image in a discussion reply…" | **Partial** — wrong container (discussion not page), but `highlight` is exactly the Alt-Text steps | 6,384 ch ≈ 1,600 tok |
| embed HTML in a Canvas page | "How do I edit a page in a course?" | **Partial** — adjacent, not the HTML-editor article | 4,044 ch ≈ 1,010 tok |
| export quiz to QTI | "How do I export quiz content from a course?" | **Yes** — exact, mentions QTI 1.2 ZIP | 1,289 ch ≈ 320 tok |

- **(a) Targeted vs links/whole-doc/nothing:** Returns ranked *whole articles* + a short `highlight`
  snippet. Because the guide is authored as atomic "How do I X?" topics, "whole article" ≈ one targeted
  section. So you get a specific section, not a link list and not a giant manual.
- **(b) Size:** top-hit `bodyPlainText` 320–2,300 tokens; corpus tail larger (SpeedGrader ≈ 5,280 tok,
  "add users" ≈ 3,860 tok). HTML `body` is 3–5× bigger (markup + embedded guidde video iframes) — use
  `bodyPlainText`, not `body`.
- **(c) Latency:** 75–405 ms.
- **(d) Format:** `application/json; charset=utf-8`, array of result objects.

**Relevance is the weak axis:** this is lexical/BM25-style matching, not semantic. It nailed the
keyword-aligned query (QTI export), produced a usable highlight for alt-text, but missed on the two
conceptual queries ("accessible quiz", "embed HTML") where the user's words don't match article
titles/bodies. `locale` defaults to mixed languages — you MUST pass `locale=en` (first probe returned
Chinese).

## Step 3 — Evidence files
- `evidence/search_q{1..4}.json` — raw search responses (111–267 KB each)
- `evidence/q{1..4}_top1_plaintext.txt` — `bodyPlainText` of each top hit (the actual LLM-ready content)
- `evidence/robots.txt`, `evidence/home_403_body.html` — platform/gating evidence
- `run_queries.sh` — reproducible harness

## Step 4 — Verdict

**Yes, a real API exists and it CAN return a specific, context-sized guide section per query** — on the
three axes of *access, size, and latency* it cleanly supports a live-API retrieval design:
- Access: open `/api/v2/search`, no auth/key, JSON.
- Size: atomic articles, `bodyPlainText` typically <2.5k tokens (worst-case ~5k); `highlight` smaller still.
- Latency: sub-500 ms.

**The one caveat is relevance: it's lexical, not semantic**, and missed 2 of 4 topical queries. That is
exactly the gap a vector store closes.

**Recommendation — the API makes BOTH designs viable; choose on relevance need:**
- If keyword-ish queries are acceptable → call `/api/v2/search?knowledgeBaseID=39&locale=en` live and
  feed `bodyPlainText`/`highlight` of the top hit(s). Zero infra.
- For dependable semantic relevance → **pre-index**. The same API is the ideal ingestion source: page
  `/api/v2/articles?knowledgeBaseID=39` (638 atomic, pre-chunked docs), embed `bodyPlainText`, store in a
  local vector DB. Best quality; small one-time crawl; immune to Cloudflare HTML gating.

Best of both: pre-index for relevance, keep the live `/search` call as a fallback/freshness check.
