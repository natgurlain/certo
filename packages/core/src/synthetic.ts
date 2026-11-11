import { sha256Hex, toBase64, toHex, utf8 } from './encode.js';
import { ed25519FromLabel, ed25519Sign, nearaiSignatureText, type Ed25519Key } from './signing.js';
import type { PanelRecording } from './types.js';

/** Default seed label for synthetic juror keys (test keys; never real NEAR AI keys). */
export const SYNTHETIC_SEED = 'certo-synthetic-jurors-v1';

/** Deterministic test key for juror `jurorIndex` (or the gateway with index -1). */
export function syntheticJurorKey(jurorIndex: number, seedKey: string = SYNTHETIC_SEED): Ed25519Key {
  return ed25519FromLabel(`${seedKey}:${jurorIndex < 0 ? 'gateway' : `juror:${jurorIndex}`}`);
}

/** Chat-completions response body in NEAR AI's (OpenAI-compatible) shape. */
export function syntheticChatResponse(args: { chatId: string; model: string; content: string; created?: number }): string {
  return JSON.stringify({
    id: args.chatId,
    object: 'chat.completion',
    created: args.created ?? 1794300000,
    model: args.model,
    choices: [{ index: 0, message: { role: 'assistant', content: args.content }, logprobs: null, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
}

/**
 * A ballot in the exact NEAR AI recording shape, signed with a deterministic
 * test key (`provider_tee` text `<model>:<sha256 req>:<sha256 resp>`), marked
 * `synthetic: true`. Used until `make record` replaces it with real ballots.
 */
export function makeSyntheticBallot(args: {
  jurorIndex: number;
  model: string;
  requestBody: string;
  responseContent: string;
  seedKey?: string;
  recordedAt?: string;
}): PanelRecording {
  const key = syntheticJurorKey(args.jurorIndex, args.seedKey);
  const chatId = `chatcmpl-synthetic-${sha256Hex(args.model + '\n' + args.requestBody).slice(0, 24)}`;
  const responseBody = syntheticChatResponse({ chatId, model: args.model, content: args.responseContent });
  const text = nearaiSignatureText('provider_tee', args.model, sha256Hex(args.requestBody), sha256Hex(responseBody));
  return {
    model: args.model,
    request_body: args.requestBody,
    response_body_b64: toBase64(utf8(responseBody)),
    chat_id: chatId,
    signature: {
      text,
      signature: toHex(ed25519Sign(text, key)),
      signing_address: toHex(key.publicKey),
      signing_algo: 'ed25519',
      signature_kind: 'provider_tee',
    },
    latency_ms: 0,
    recorded_at: args.recordedAt ?? '1970-01-01T00:00:00.000Z',
    synthetic: true,
  };
}
