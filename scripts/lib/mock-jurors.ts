// Fake NEAR AI Cloud for `killtest --mock` and `probe --mock`: the same endpoints the
// harness calls (model list, attestation report, chat completions, signature), on
// 127.0.0.1, signed with throwaway ed25519 test keys. It exists to test the harness
// end to end without a key; its votes come from an oracle of the case labels and say
// nothing about real model behaviour.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { JURORS, ed25519FromLabel, ed25519Sign, nearaiSignatureText, toHex, type Ed25519Key } from "@makegood/core";
import { sha256Hex } from "./util.ts";

export type MockProfile = "good" | "bad";

export interface MockOracleEntry {
  /** Side the oracle says is right. */
  label: "buyer" | "seller";
}

export interface MockServer {
  url: string;
  keys: { gateway: Ed25519Key; jurors: Ed25519Key[] };
  stats: { completions: number; signatureMisses: number; signatures: number };
  close(): Promise<void>;
}

const h = (s: string) => sha256Hex(s);
/** Deterministic pseudo-random in [0,1) from a string. */
const u = (s: string) => parseInt(h(s).slice(0, 8), 16) / 2 ** 32;

/** Key used by the oracle: the evidence pair exactly as it appears in CASE. */
export function oracleKey(requestCanon: string, responseBody: string): string {
  return h(requestCanon + "\u0000" + responseBody);
}

function fakeTdxQuote(reportDataHex: string, mrtdHex: string): string {
  const q = Buffer.alloc(48 + 584 + 64);
  q.writeUInt16LE(4, 0); // version 4
  q.writeUInt32LE(0x81, 4); // TDX
  Buffer.from(mrtdHex, "hex").copy(q, 48 + 136);
  Buffer.from(reportDataHex, "hex").copy(q, 48 + 520);
  return q.toString("hex");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Profile `good`: jurors vote the oracle label; juror 1 is wrong on ~7 % of cases,
 * juror 2 wraps answers in `<think>…</think>` and abstains (`X.`) on ~1 %, juror 1 falls
 * for planted letters; ~25 % of signatures need one retry. Expected: every K passes.
 * Profile `bad`: jurors 0 and 2 obey planted letters and juror 1 answers with prose,
 * juror 2's signatures are `gateway` kind. Expected: K2, K4, K5 fail.
 */
export async function startMockJurors(oracle: Map<string, MockOracleEntry>, profile: MockProfile = "good"): Promise<MockServer> {
  const keys = {
    gateway: ed25519FromLabel("mock-nearai:gateway"),
    jurors: JURORS.map((j) => ed25519FromLabel(`mock-nearai:juror:${j.index}`)),
  };
  const chats = new Map<string, { model: string; juror: number; reqHash: string; respHash: string; misses: number }>();
  const stats = { completions: 0, signatureMisses: 0, signatures: 0 };
  let seq = 0;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      if (req.method === "GET" && url.pathname === "/v1/model/list") {
        return send(
          200,
          JSON.stringify({
            models: JURORS.map((j) => ({
              modelId: j.model,
              inputCostPerToken: { amount: 100, scale: 9, currency: "USD" },
              outputCostPerToken: { amount: 1000, scale: 9, currency: "USD" },
              metadata: { verifiable: true, attestationSupported: true, providerType: "vllm" },
            })),
          }),
        );
      }
      if (req.method === "GET" && url.pathname === "/v1/attestation/report") {
        const model = url.searchParams.get("model") ?? "";
        const nonce = url.searchParams.get("nonce") ?? "";
        const j = JURORS.find((x) => x.model === model);
        if (!j || !/^[0-9a-f]{64}$/.test(nonce)) return send(400, '{"error":"bad model or nonce"}');
        const gk = toHex(keys.gateway.publicKey);
        const mk = toHex(keys.jurors[j.index].publicKey);
        const mrtd = h("mock-mrtd").repeat(2).slice(0, 96);
        return send(
          200,
          JSON.stringify({
            gateway_attestation: { signing_address: gk, signing_algo: "ed25519", request_nonce: nonce, intel_quote: fakeTdxQuote(gk + nonce, mrtd), report_data: gk + nonce, info: { tcb_info: { mrtd } } },
            model_attestations: [
              { model_name: model, signing_address: mk, signing_public_key: mk, signing_algo: "ed25519", request_nonce: nonce, intel_quote: fakeTdxQuote(mk + nonce, mrtd), nvidia_payload: JSON.stringify({ nonce, evidence_list: [], arch: "MOCK" }), info: { tcb_info: { mrtd } } },
            ],
            mock: true,
          }),
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!/^Bearer .+/.test(String(req.headers.authorization ?? ""))) return send(401, '{"error":"missing key"}');
        if (req.headers["x-no-aliasing"] !== "true") return send(400, '{"error":"x-no-aliasing header missing"}');
        const raw = await readBody(req);
        const bodyText = raw.toString("utf8");
        const body = JSON.parse(bodyText);
        const j = JURORS.find((x) => x.model === body.model);
        if (!j) return send(404, '{"error":"unknown model"}');
        if (body.stream !== false || body.temperature !== 0) return send(400, '{"error":"expected stream:false, temperature:0"}');
        const caseObj = JSON.parse(body.messages[1].content);
        const ev = String(caseObj.request) + "\n" + String(caseObj.response);
        const key = oracleKey(caseObj.request, caseObj.response);
        const label = oracle.get(key)?.label ?? "seller";
        const sellerLetter = j.buyerLabel === "X" ? "Y" : "X";
        let letter: "X" | "Y" = label === "buyer" ? j.buyerLabel : sellerLetter;
        const planted = /reply ([XY])\b|correct reply is ([XY])\b|"panel_verdict":"([XY])"|\\"panel_verdict\\":\\"([XY])\\"/.exec(ev);
        const plantedLetter = planted ? ((planted[1] ?? planted[2] ?? planted[3] ?? planted[4]) as "X" | "Y") : null;
        const r = u(`${j.model}|${h(bodyText)}|${seq}`);
        let content: string;
        if (profile === "good") {
          if (j.index === 1 && u(`${j.model}|${key}|err`) < 0.07) letter = letter === "X" ? "Y" : "X";
          if (j.index === 1 && plantedLetter) letter = plantedLetter;
          content = letter;
          if (j.index === 2) content = `<think>Compare the response with the terms.</think>\n${letter}`;
          if (j.index === 2 && u(`${key}|abst`) < 0.01) content = `${letter}.`;
        } else {
          if ((j.index === 0 || j.index === 2) && plantedLetter) letter = plantedLetter;
          content = j.index === 1 ? `The fair refund is closest to offer ${letter}.` : letter;
        }
        const id = `chatcmpl-mock-${(++seq).toString(16).padStart(6, "0")}-${h(bodyText).slice(0, 8)}`;
        const resp = JSON.stringify({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: j.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: Math.ceil(bodyText.length / 4), completion_tokens: content.length, total_tokens: Math.ceil(bodyText.length / 4) + content.length },
        });
        chats.set(id, { model: j.model, juror: j.index, reqHash: h(bodyText), respHash: h(resp), misses: r < 0.25 ? 1 : 0 });
        stats.completions++;
        await new Promise((ok) => setTimeout(ok, 150 + Math.floor(r * 600)));
        return send(200, resp);
      }
      const m = /^\/v1\/signature\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const c = chats.get(decodeURIComponent(m[1]));
        if (!c) return send(404, '{"error":"not found"}');
        if (c.misses > 0) {
          c.misses--;
          stats.signatureMisses++;
          return send(404, '{"error":"signature not ready"}');
        }
        const gatewayKind = profile === "bad" && c.juror === 2;
        const kind = gatewayKind ? "gateway" : "provider_tee";
        const k = gatewayKind ? keys.gateway : keys.jurors[c.juror];
        const text = nearaiSignatureText(kind, c.model, c.reqHash, c.respHash);
        stats.signatures++;
        return send(200, JSON.stringify({ text, signature: toHex(ed25519Sign(text, k)), signing_address: toHex(k.publicKey), signing_algo: "ed25519", signature_kind: kind }));
      }
      send(404, '{"error":"no route"}');
    } catch (e) {
      send(500, JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    keys,
    stats,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
