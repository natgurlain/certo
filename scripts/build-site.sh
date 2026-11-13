#!/bin/bash
# Builds the static replay site in site/ (git-ignored): the demo page plus two recorded runs.
#   feed.json   NEAR testnet run of 2026-11-13 (default; explorer links on every transaction)
#   local.json  local sandbox run with all five scenes (open the page with ?feed=local.json)
#   og.png      1200x630 link preview; absolute URLs in index.html's meta tags point at https://certo-bice.vercel.app
# Deploy the folder to any static host, e.g. `npx vercel deploy site --prod`.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf site && mkdir -p site
cp apps/demo/web/index.html apps/demo/web/app.js apps/demo/web/pace.js apps/demo/web/verify.js apps/demo/web/style.css site/
cp apps/demo/web/og.png site/   # link preview (og:image), a screenshot of the scene 2 verdict
cp fixtures/demo/feed-testnet.json site/feed.json
cp fixtures/demo/feed-local.json site/local.json
echo "site/ ready: $(ls site | tr '\n' ' ')"
