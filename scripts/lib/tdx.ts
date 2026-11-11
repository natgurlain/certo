// Minimal Intel TDX quote reader: extracts REPORTDATA and checks that it binds
// (signing public key, nonce). This is NOT quote verification: the quote's
// ECDSA signature, the PCK certificate chain to Intel's root, TCB collateral,
// RTMR replay of the event log, the compose hash and the NVIDIA GPU evidence
// are all left unchecked. See docs/VERIFY.md.

const HEADER_LEN = 48;
// TD 1.0 report body: TEE_TCB_SVN 16, MRSEAM 48, MRSIGNERSEAM 48, SEAMATTRIBUTES 8,
// TDATTRIBUTES 8, XFAM 8, MRTD 48, MRCONFIGID 48, MROWNER 48, MROWNERCONFIG 48,
// RTMR0..3 4x48, REPORTDATA 64.
const MRTD_OFFSET = 16 + 48 + 48 + 8 + 8 + 8; // 136
const REPORT_DATA_OFFSET = MRTD_OFFSET + 48 * 4 + 48 * 4; // 520
const TEE_TYPE_TDX = 0x81;

export interface TdxQuoteFields {
  version: number;
  teeType: number;
  mrtd: string;
  reportData: string; // 64 bytes, hex
}

export function parseTdxQuote(quoteHex: string): TdxQuoteFields {
  if (!/^[0-9a-fA-F]+$/.test(quoteHex)) throw new Error("quote is not hex");
  const q = Buffer.from(quoteHex, "hex");
  if (q.length < HEADER_LEN + 6 + REPORT_DATA_OFFSET + 64) throw new Error(`quote too short (${q.length} bytes)`);
  const version = q.readUInt16LE(0);
  const teeType = q.readUInt32LE(4);
  if (teeType !== TEE_TYPE_TDX) throw new Error(`not a TDX quote (tee type 0x${teeType.toString(16)})`);
  let body: number;
  if (version === 4) body = HEADER_LEN;
  else if (version === 5) body = HEADER_LEN + 2 + 4; // body type (u16) + body size (u32)
  else throw new Error(`unsupported quote version ${version}`);
  return {
    version,
    teeType,
    mrtd: q.subarray(body + MRTD_OFFSET, body + MRTD_OFFSET + 48).toString("hex"),
    reportData: q.subarray(body + REPORT_DATA_OFFSET, body + REPORT_DATA_OFFSET + 64).toString("hex"),
  };
}

export interface BindingResult {
  ok: boolean;
  keyBound: boolean; // REPORTDATA[0..32] == ed25519 public key
  nonceBound: boolean; // REPORTDATA[32..64] == our nonce
  mrtdMatchesInfo: boolean | null; // quote MRTD == info.tcb_info.mrtd (null if absent)
  reportData: string;
  detail: string;
}

/**
 * The NEAR AI Cloud attestation puts `public key (32 bytes) ‖ nonce (32 bytes)`
 * into the TDX REPORTDATA when `signing_algo=ed25519` (observed for the gateway
 * and every model on 2026-11-11).
 */
export function checkBinding(quoteHex: string, publicKeyHex: string, nonceHex: string, infoMrtd?: string): BindingResult {
  const q = parseTdxQuote(quoteHex);
  const keyBound = q.reportData.slice(0, 64) === publicKeyHex.toLowerCase();
  const nonceBound = q.reportData.slice(64, 128) === nonceHex.toLowerCase();
  const mrtdMatchesInfo = infoMrtd ? q.mrtd === infoMrtd.toLowerCase() : null;
  const ok = keyBound && nonceBound && mrtdMatchesInfo !== false;
  const detail = ok
    ? "key and nonce in REPORTDATA"
    : [!keyBound && "key not in REPORTDATA[0..32]", !nonceBound && "nonce not in REPORTDATA[32..64]", mrtdMatchesInfo === false && "MRTD differs from tcb_info"]
        .filter(Boolean)
        .join("; ");
  return { ok, keyBound, nonceBound, mrtdMatchesInfo, reportData: q.reportData, detail };
}

/** Check one saved attestation report (raw JSON text) for a model and its gateway. */
export function checkReport(
  report: any,
  model: string,
  nonce: string,
): { model: BindingResult & { publicKey: string }; gateway: BindingResult & { publicKey: string }; problems: string[] } {
  const problems: string[] = [];
  const ga = report?.gateway_attestation;
  const mas = report?.model_attestations;
  if (!ga) throw new Error("report has no gateway_attestation");
  if (!Array.isArray(mas) || mas.length !== 1) throw new Error(`expected exactly 1 model attestation, got ${Array.isArray(mas) ? mas.length : "none"}`);
  const ma = mas[0];
  if (ma.model_name !== model) problems.push(`model_name ${ma.model_name} != ${model}`);
  for (const [who, a] of [["gateway", ga], ["model", ma]] as const) {
    if (a.signing_algo !== "ed25519") problems.push(`${who} signing_algo ${a.signing_algo}`);
    if (a.request_nonce !== nonce) problems.push(`${who} request_nonce differs from ours`);
    if (!/^[0-9a-f]{64}$/.test(a.signing_address ?? "")) problems.push(`${who} signing_address is not a 32-byte hex key`);
  }
  if (ma.signing_public_key && ma.signing_public_key !== ma.signing_address) problems.push("model signing_public_key != signing_address");
  if (typeof ga.report_data === "string") {
    const q = parseTdxQuote(ga.intel_quote);
    if (q.reportData !== ga.report_data) problems.push("gateway report_data field differs from the quote");
  }
  if (typeof ma.nvidia_payload === "string") {
    try {
      if (JSON.parse(ma.nvidia_payload).nonce !== nonce) problems.push("nvidia_payload nonce differs from ours");
    } catch {
      problems.push("nvidia_payload is not JSON");
    }
  } else problems.push("model attestation has no nvidia_payload");
  const m = checkBinding(ma.intel_quote, ma.signing_address, nonce, ma.info?.tcb_info?.mrtd);
  const g = checkBinding(ga.intel_quote, ga.signing_address, nonce, ga.info?.tcb_info?.mrtd);
  if (!m.ok) problems.push(`model quote: ${m.detail}`);
  if (!g.ok) problems.push(`gateway quote: ${g.detail}`);
  return { model: { ...m, publicKey: ma.signing_address }, gateway: { ...g, publicKey: ga.signing_address }, problems };
}
