// Shape of fixtures/jurors.json (written by scripts/fetch-attestations.ts).

export interface JurorEntry {
  index: number;
  model: string;
  buyer_letter: "X" | "Y";
  public_key: string; // ed25519, 32 bytes hex
  report_path: string; // repo-relative
  report_sha256: string; // over the raw bytes as received
  report_bytes: number;
  nonce: string;
  binding_ok: boolean;
  fetch_ms: number;
}

export interface JurorsFile {
  version: 1;
  epoch: number;
  fetched_at: string;
  source: string;
  signing_algo: "ed25519";
  binding_check: string;
  gateway: {
    public_key: string;
    report_path: string;
    report_pointer: string;
    report_sha256: string;
    nonce: string;
    binding_ok: boolean;
  };
  jurors: JurorEntry[];
  previous_epochs: {
    epoch: number;
    fetched_at: string;
    gateway_public_key: string;
    jurors: { model: string; public_key: string; report_path: string; report_sha256: string }[];
  }[];
}

/** Every (model → key) pair ever registered, newest first, with its epoch. */
export function knownKeys(jf: JurorsFile): { epoch: number; model: string | null; public_key: string; role: "juror" | "gateway" }[] {
  const out: { epoch: number; model: string | null; public_key: string; role: "juror" | "gateway" }[] = [];
  out.push(...jf.jurors.map((j) => ({ epoch: jf.epoch, model: j.model, public_key: j.public_key, role: "juror" as const })));
  out.push({ epoch: jf.epoch, model: null, public_key: jf.gateway.public_key, role: "gateway" });
  for (const p of [...jf.previous_epochs].reverse()) {
    out.push(...p.jurors.map((j) => ({ epoch: p.epoch, model: j.model, public_key: j.public_key, role: "juror" as const })));
    out.push({ epoch: p.epoch, model: null, public_key: p.gateway_public_key, role: "gateway" });
  }
  return out;
}
