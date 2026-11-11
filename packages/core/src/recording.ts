import { fromBase64, sha256Hex, toBase64 } from './encode.js';
import { decodeSignature, verifyNearAiBallot, type BallotCheck } from './signing.js';
import type { ContractBallot, PanelRecording } from './types.js';

/** File name (without directory) of a recording: `<sha256 of request body>.json`. */
export function recordingFileName(requestBody: string): string {
  return `${sha256Hex(requestBody)}.json`;
}

export function recordingResponseBody(r: PanelRecording): string {
  return Buffer.from(fromBase64(r.response_body_b64)).toString('utf8');
}

/** Contract `Ballot` argument from a recording (signature re-encoded as base64). */
export function toContractBallot(r: PanelRecording): ContractBallot {
  return {
    response_body: recordingResponseBody(r),
    signature: toBase64(decodeSignature(r.signature.signature)),
    kind: r.signature.signature_kind,
  };
}

/** Offline verification of a recording (hashes, text, ed25519). */
export function verifyRecording(r: PanelRecording, expectedKey?: Uint8Array | string): BallotCheck {
  return verifyNearAiBallot({
    model: r.model,
    requestBody: r.request_body,
    responseBody: fromBase64(r.response_body_b64),
    signature: r.signature,
    expectedKey,
  });
}
