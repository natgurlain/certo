/**
 * Demo fixtures (`fixtures/demo/demo.json`) and the panel cases and juror keys
 * derived from them. The panel prompt holds only terms, request, response and
 * offers, so these bodies decide which recordings in `fixtures/panel/` replay.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JURORS, buildPanelRequestFor, recordingFileName, syntheticJurorKey, toHex, SYNTHETIC_SEED, type PanelRecording,
} from '@certo/core';
import { repoFile } from './sandbox.js';

export type DemoSeller = 'chainfacts' | 'cheapfacts';

export interface DemoFixtures {
  terms: { terms_id: string; text: string; panel: boolean };
  /** Path with query the buyer requests in every scene. */
  request: string;
  /** Price in base units. */
  price: string;
  /** Exact response body each seller serves for `request`. */
  responses: Record<DemoSeller, string>;
}

export function loadDemo(): DemoFixtures {
  return JSON.parse(readFileSync(repoFile('fixtures/demo/demo.json'), 'utf8')) as DemoFixtures;
}

/** One panel case of the demo, in the kill-test line shape `scripts/record.ts` reads. */
export interface DemoCase {
  id: string;
  scene: number;
  seller: DemoSeller;
  terms_text: string;
  request_canon: string;
  response_body: string;
  buyer_offer_pct: number;
  seller_offer_pct: number;
  /** Side the panel should pick (used for synthetic ballots). */
  label: 'buyer' | 'seller';
  note: string;
}

/** Scene 2 (asked NEAR, got NEO → buyer) and scene 3 (lying buyer → seller). Offers: buyer 100 %, seller 0 %. */
export function demoCases(d: DemoFixtures = loadDemo()): DemoCase[] {
  const canon = `GET\n${d.request}\n`;
  return [
    {
      id: 'demo-scene2', scene: 2, seller: 'cheapfacts', terms_text: d.terms.text, request_canon: canon,
      response_body: d.responses.cheapfacts, buyer_offer_pct: 100, seller_offer_pct: 0, label: 'buyer',
      note: 'Scene 2: asked NEAR, cheapfacts answered about NEO.',
    },
    {
      id: 'demo-scene3', scene: 3, seller: 'chainfacts', terms_text: d.terms.text, request_canon: canon,
      response_body: d.responses.chainfacts, buyer_offer_pct: 100, seller_offer_pct: 0, label: 'seller',
      note: 'Scene 3: scout-liar disputes correct NEAR data from chainfacts.',
    },
  ];
}

/** The six exact chat-completions bodies (2 cases × 3 jurors) the contract will build. */
export function demoPanelBodies(d: DemoFixtures = loadDemo()) {
  return demoCases(d).flatMap((c) => JURORS.map((j) => ({
    caseId: c.id, juror: j.index, model: j.model,
    body: buildPanelRequestFor({
      jurorIndex: j.index, termsText: c.terms_text, requestCanon: c.request_canon, responseBody: c.response_body,
      buyerOfferBps: c.buyer_offer_pct * 100, sellerOfferBps: c.seller_offer_pct * 100,
    }),
  })));
}

/** `fixtures/jurors.synthetic.json`: deterministic TEST keys, derived from a published seed. */
export interface SyntheticJurorsFile {
  synthetic: true;
  note: string;
  seed: string;
  gateway: { public_key: string };
  jurors: Array<{ index: number; model: string; public_key: string; attestation_sha256: string }>;
}

export function syntheticJurorsFile(seed = SYNTHETIC_SEED): SyntheticJurorsFile {
  return {
    synthetic: true,
    note: 'TEST keys for replay-synthetic mode. Seed = sha256("<seed>:juror:<i>") (gateway: "<seed>:gateway"); anyone can sign with them. They are not NEAR AI keys and have no attestation (attestation_sha256 is all zeros).',
    seed,
    gateway: { public_key: toHex(syntheticJurorKey(-1, seed).publicKey) },
    jurors: JURORS.map((j) => ({
      index: j.index, model: j.model, public_key: toHex(syntheticJurorKey(j.index, seed).publicKey), attestation_sha256: '0'.repeat(64),
    })),
  };
}

export type PanelMode = 'live' | 'replay' | 'replay-synthetic';

export interface PanelPlan {
  mode: PanelMode;
  /** Keys the sandbox contract is initialised with. */
  jurors: Array<{ model_id: string; pubkey: string; attestation_sha256: string }>;
  gatewayKey: string | null;
  acceptGateway: boolean;
  recordedAt?: string;
  /** Human-readable reason for the choice. */
  why: string;
}

interface RealJurorsFile {
  gateway: { public_key: string };
  jurors: Array<{ index: number; model: string; public_key: string; report_sha256: string }>;
}

export function realKeys(): Pick<PanelPlan, 'jurors' | 'gatewayKey'> {
  const jf = JSON.parse(readFileSync(repoFile('fixtures/jurors.json'), 'utf8')) as RealJurorsFile;
  return {
    jurors: JURORS.map((j) => {
      const e = jf.jurors.find((x) => x.model === j.model);
      if (!e) throw new Error(`fixtures/jurors.json has no key for ${j.model}`);
      return { model_id: j.model, pubkey: e.public_key, attestation_sha256: e.report_sha256 };
    }),
    gatewayKey: jf.gateway.public_key,
  };
}

/**
 * Pick the panel mode:
 * - `live` when `PANEL_MODE=live` (needs `NEARAI_API_KEY`); contract keys from `fixtures/jurors.json`;
 * - `replay` when every demo ballot in `fixtures/panel/` is a real recording; keys from `fixtures/jurors.json`;
 * - `replay-synthetic` when they are synthetic; keys from `fixtures/jurors.synthetic.json`.
 * Anything else (missing or mixed recordings) is an error naming the fix.
 */
export function choosePanel(env: NodeJS.ProcessEnv = process.env, panelDir = repoFile('fixtures/panel')): PanelPlan {
  if (env.PANEL_MODE === 'live') {
    if (!env.NEARAI_API_KEY) throw new Error('PANEL_MODE=live needs NEARAI_API_KEY');
    return { mode: 'live', ...realKeys(), acceptGateway: true, why: 'PANEL_MODE=live and NEARAI_API_KEY set' };
  }
  if (env.PANEL_MODE && env.PANEL_MODE !== 'replay') throw new Error(`PANEL_MODE must be live or replay, got ${env.PANEL_MODE}`);
  const recs: PanelRecording[] = [];
  const missing: string[] = [];
  for (const b of demoPanelBodies()) {
    const p = join(panelDir, recordingFileName(b.body));
    if (!existsSync(p)) missing.push(`${b.caseId}/juror${b.juror}`);
    else recs.push(JSON.parse(readFileSync(p, 'utf8')) as PanelRecording);
  }
  if (missing.length) {
    throw new Error(`no recording for ${missing.join(', ')} in ${panelDir}; run \`make record\` (needs NEARAI_API_KEY) or \`npx tsx apps/demo/write-fixtures.ts --synthetic\``);
  }
  const synth = recs.filter((r) => r.synthetic === true).length;
  const acceptGateway = recs.some((r) => r.signature.signature_kind === 'gateway');
  const recordedAt = recs.map((r) => r.recorded_at).sort().at(-1);
  if (synth === 0) return { mode: 'replay', ...realKeys(), acceptGateway, recordedAt, why: 'all demo ballots are real recordings' };
  if (synth === recs.length) {
    const sf = JSON.parse(readFileSync(repoFile('fixtures/jurors.synthetic.json'), 'utf8')) as SyntheticJurorsFile;
    const expect = syntheticJurorsFile(sf.seed);
    if (JSON.stringify(expect.jurors) !== JSON.stringify(sf.jurors)) throw new Error('fixtures/jurors.synthetic.json does not match its seed');
    return {
      mode: 'replay-synthetic',
      jurors: sf.jurors.map((j) => ({ model_id: j.model, pubkey: j.public_key, attestation_sha256: j.attestation_sha256 })),
      gatewayKey: sf.gateway.public_key, acceptGateway, recordedAt, why: 'demo ballots are synthetic (no NEAR AI recording yet)',
    };
  }
  throw new Error(`fixtures/panel mixes real and synthetic ballots for the demo cases (${synth}/${recs.length} synthetic); re-run \`make record\``);
}
