#!/bin/bash
# Builds the static site in site/ (git-ignored). No framework, no bundler: files are copied as they are.
#   /                 landing page (apps/landing/index.html, landing.css, landing.js)
#   /verify           full verification report (apps/landing/verify/index.html); runs on load
#   /demo             the replay (apps/demo/web), with its two recorded runs:
#                       demo/feed.json   NEAR testnet run (default; explorer links on every transaction)
#                       demo/local.json  local sandbox run with all five scenes (/demo?feed=local.json)
#   /certo-demo.mp4   the 60 s video and its poster (apps/landing/media; swap the files to re-cut)
#   /og.png           1200x630 link preview of the landing (apps/landing/og.png)
#   /llms.txt, /favicon.svg, /fonts/
# The testnet ruling transaction linked from the landing page is not written anywhere by hand: it is read
# here from the recorded testnet feed (scene 2's panel ruling), so a new testnet run updates every link.
# Deploy the folder to any static host, e.g. `npx vercel deploy site --prod` (site/vercel.json: clean URLs).
set -euo pipefail
cd "$(dirname "$0")/.."
FEED=fixtures/demo/feed-testnet.json
rm -rf site && mkdir -p site/demo site/verify site/fonts

# the replay, under /demo/. Its page loads app.js, style.css and feed.json by relative URL; a <base> tag keeps
# them under /demo/ whether the host serves the page as /demo or /demo/.
cp apps/demo/web/app.js apps/demo/web/pace.js apps/demo/web/verify.js apps/demo/web/style.css apps/demo/web/og.png site/demo/
sed 's|<head>|<head><base href="/demo/">|' apps/demo/web/index.html > site/demo/index.html
grep -q '<base href="/demo/">' site/demo/index.html || { echo "build-site: could not add <base> to the demo page" >&2; exit 1; }
cp "$FEED" site/demo/feed.json
cp fixtures/demo/feed-local.json site/demo/local.json

# the scene 2 ruling transaction, from the feed (verify.js findCase: the same case the verify button checks)
RULING_TX=$(node --input-type=module -e "
import { findCase } from './apps/demo/web/verify.js';
import { readFileSync } from 'node:fs';
process.stdout.write(findCase(JSON.parse(readFileSync('$FEED', 'utf8'))).resolveTx);")
[[ "$RULING_TX" =~ ^[1-9A-HJ-NP-Za-km-z]{43,44}$ ]] || { echo "build-site: no ruling transaction in $FEED" >&2; exit 1; }

# landing and /verify; __RULING_TX__ is the only placeholder
for f in index.html verify/index.html; do
  sed "s/__RULING_TX__/$RULING_TX/g" "apps/landing/$f" > "site/$f"
done
cp apps/landing/landing.css apps/landing/landing.js apps/landing/verify-view.js apps/landing/favicon.svg apps/landing/og.png site/
cp apps/landing/fonts/inter-latin-wght.woff2 apps/landing/fonts/Inter-OFL.txt site/fonts/
cp apps/landing/media/certo-demo.mp4 apps/landing/media/certo-demo-poster.jpg site/
cp apps/landing/vercel.json site/
cp llms.txt site/
if grep -rq "__RULING_TX__" site; then echo "build-site: unreplaced placeholder" >&2; exit 1; fi
echo "site/ ready (ruling tx $RULING_TX): $(cd site && find . -type f | sort | tr '\n' ' ')"
