#!/usr/bin/env bash
# Empirical test of Canvas Community Vanilla search API for instructor-guide retrieval.
# For each query: hit /api/v2/search scoped to the Instructor Guide KB (39), in English,
# capture raw JSON, latency, top-5 relevance, and content sizes (HTML + plaintext + highlight).
set -u
BASE="https://community.instructure.com/api/v2/search"
KB=39
UA="Mozilla/5.0 (research)"
mkdir -p evidence

queries=(
  "how do I create an accessible quiz"
  "add alt text to images in a page"
  "embed HTML in a Canvas page"
  "export quiz to QTI"
)

i=0
for q in "${queries[@]}"; do
  i=$((i+1))
  out="evidence/search_q${i}.json"
  echo "==================================================================="
  echo "QUERY $i: \"$q\""
  echo "-------------------------------------------------------------------"
  # timed request, raw body to file, timing to stderr capture
  timing=$(curl -sS -A "$UA" -G "$BASE" \
    --data-urlencode "query=$q" \
    --data-urlencode "knowledgeBaseID=$KB" \
    --data-urlencode "recordTypes[]=article" \
    --data-urlencode "locale=en" \
    --data-urlencode "limit=5" \
    -w 'http_code=%{http_code} time_total=%{time_total}s size=%{size_download}B ctype=%{content_type}' \
    -o "$out")
  echo "RESPONSE: $timing   (raw saved -> $out)"
  echo "FORMAT: $(file --mime-type -b "$out" 2>/dev/null) ; top-level JSON type: $(jq -r 'type' "$out" 2>/dev/null)"
  echo
  echo "TOP 5 RESULTS (searchScore | plaintextChars | ~tokens | title):"
  jq -r '.[] | "  \(.searchScore // "n/a")\t\((.bodyPlainText|length))\t~\((.bodyPlainText|length)/4|floor)\t\(.name)"' "$out" 2>/dev/null
  echo
  echo "TOP-1 detail:"
  jq -r '.[0] | "  title: \(.name)\n  url:   \(.url|split("?")[0])\n  htmlBodyChars: \(.body|length)  (~\((.body|length)/4|floor) tokens)\n  plainTextChars: \(.bodyPlainText|length)  (~\((.bodyPlainText|length)/4|floor) tokens)"' "$out" 2>/dev/null
  echo
  echo "TOP-1 highlight snippet (the 'targeted section' the API returns):"
  jq -r '.[0].highlight // "(no highlight field)"' "$out" 2>/dev/null | head -c 700
  echo
  echo
done
