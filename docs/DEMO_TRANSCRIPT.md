# make demo transcript

Recorded 2026-11-13T12:58Z on macOS arm64 (Apple M2), nearcore 2.10.0 sandbox, commit e374065, with the committed recorded NEAR AI ballots. Reproduce with `npm ci && make demo`.

```text
Certo demo: local NEAR sandbox (nearcore 2.10.0), panel mode replay: all demo ballots are real recordings
page and event feed: http://localhost:4020
01  sandbox up: contract certo, token usdc (mock USDC, 6 decimals); sellers honest-api and shady-api bonded 50.000000 each; buyers agent and liar-agent hold 10.000000
02  demo sellers serve fixed fixture data behind the Certo middleware; panel service (replay) and resolver account 'resolver' running
03  agent → honest-api: GET /v1/holders?token=NEAR&top=5 (price 0.400000; 402 quote → pay on chain → retry with proof)
04  delivered 562 bytes with a seller-signed receipt; agent: token NEAR as requested → accept
Scene 1 honest call: agent paid honest-api 0.400000, fee 0.004000 (1.0%), seller balance +0.396000 in the paying transaction GQwcDxVY…
05  agent → shady-api: GET /v1/holders?token=NEAR&top=5
06  agent: asked NEAR, got NEO → claim a refund
07  agent opened a content dispute: stake 0.020000, sealed offer (commitment 715ae678…)
08  shady-api answered with offer 0%
09  panel (replay): Qwen3.8-27B buyer, glm-5.3-flash buyer, DeepSeek-V4.1-Flash-1017 buyer; contract checked 3 ed25519 signatures over the prompts it rebuilt (tx 9UdBtt47…)
Scene 2 asked NEAR, got NEO: content dispute, votes buyer/buyer/buyer, 3 signatures verified by contract, refund 0.400000, bond 50.000000 → 49.580000, fee 1.0% → 1.5%
10  liar-agent → honest-api: GET /v1/holders?token=NEAR&top=5
11  liar-agent: token NEAR as requested, disputes anyway (offer 100%)
12  liar-agent opened a content dispute: stake 0.020000, sealed offer (commitment a38eadba…)
13  honest-api answered with offer 0%
14  panel (replay): Qwen3.8-27B seller, glm-5.3-flash seller, DeepSeek-V4.1-Flash-1017 seller; contract checked 3 ed25519 signatures over the prompts it rebuilt (tx 9HHXxKTi…)
Scene 3 lying buyer: liar-agent disputed correct data, votes seller/seller/seller, buyer stake 0.020000 forfeited; honest-api bond 50.000000 unchanged, fee stays 1.0%
15  agent → shady-api: GET /v1/holders?token=NEAR&top=5
16  shady-api process stopped after being paid, before delivering
17  paid, no delivery (TIMEOUT) → claim non-delivery
18  non-delivery claim open: stake 0.020000; seller has 5 s to cure
19  resolve_default by agent: refund 0.400000 + stake back; seller pays the ruling fee (tx 5AJDffCv…)
Scene 4 seller dead: seller did not answer in 5 s (demo setting; 30 s on testnet), refund 0.400000 by rule, no panel, bond 49.580000 → 49.160000, fee 1.5% → 2.5% (second loss)
20  liar-agent → honest-api: GET /v1/holders?token=NEAR&top=5, then a content dispute on the correct answer
21  attacker changed one byte of Qwen's answer Y → X (signature kept) and submitted resolve: certo (res/certo.wasm) rejected it with E_BALLOT_SIG (tx J8eiF9k3…)
22  same attack on res/guards/certo_no_g1.wasm (signature check compiled out): forged vote counted, votes buyer/seller/seller (tx isqpSZF8…)
Scene 5 forged vote: one byte of Qwen's answer Y → X changed after signing; certo rejected it with E_BALLOT_SIG; res/guards/certo_no_g1.wasm (check compiled out) counted it, votes buyer/seller/seller
DEMO OK: 5/5 scenes, 3/3 juror signatures verified on chain
(38.4 s)
feed saved: ~/.certo/demo/feed.json (the page plays it from static files: copy apps/demo/web/ and put it next to index.html as feed.json)
```
