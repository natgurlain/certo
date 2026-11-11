import {
  JURORS, majority, offerCommit, parseVote, recordingResponseBody, sha256Hex, toBase64, toContractBallot, voteToSide,
  buildPanelRequestFor, type ContractBallot, type MakegoodChain, type PanelRecording, type Side, type TxResult, type Vote,
} from '@makegood/core';
import { assertBallot, type JurorSource } from './jurors.js';

export type PanelChain = Pick<MakegoodChain, 'getCall' | 'getTerms' | 'getJurors' | 'buildPanelRequest' | 'resolve'>;

/** `POST /cases` body (section 4.3). */
export interface CaseRequest {
  call_id: string;
  buyer_offer_bps: number;
  salt: string;
  request_canon: string;
  response_body: string;
}

export interface CaseOutcome {
  call_id: string;
  tier: 'settled' | 'panel';
  mode: 'live' | 'replay';
  votes: Vote[];
  sides: Array<Side | 'abstain'>;
  winner: Side | null;
  synthetic: boolean;
  submitted: boolean;
  txHash?: string;
  events?: TxResult['events'];
  request_sha256s: string[];
  response_sha256s: string[];
  reason?: string;
}

export class CaseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CaseError';
  }
}

/** Placeholder ballots for the settlement shortcut (the contract ignores them but `[Ballot; 3]` needs three). */
export const EMPTY_BALLOT: ContractBallot = { response_body: '', signature: toBase64(new Uint8Array(64)), kind: 'provider_tee' };

export interface PanelServiceOptions {
  /** Chain client signed by the resolver account. */
  chain: PanelChain;
  jurors: JurorSource;
  /** Check each ballot offline against the on-chain juror key before submitting. Default true. */
  verifyBallots?: boolean;
  /** Submit `resolve` (false: dry run, returns the verdict only). Default true. */
  submit?: boolean;
}

/**
 * Panel service core: validate the case against the contract, get the three
 * exact request bodies from the contract view, ask the jurors (live or
 * replay), and submit `resolve` from the resolver account.
 */
export class PanelService {
  constructor(private readonly o: PanelServiceOptions) {}

  async handleCase(c: CaseRequest): Promise<CaseOutcome> {
    const chain = this.o.chain;
    if (!c || typeof c.call_id !== 'string' || typeof c.salt !== 'string' || typeof c.request_canon !== 'string' ||
      typeof c.response_body !== 'string' || !Number.isInteger(c.buyer_offer_bps)) {
      throw new CaseError(400, 'body must be {call_id, buyer_offer_bps, salt, request_canon, response_body}');
    }
    const call = await chain.getCall(c.call_id);
    if (!call) throw new CaseError(404, `call ${c.call_id} not found`);
    if (call.status !== 'Answered' || !call.dispute) throw new CaseError(409, `call status is ${call.status}, expected Answered`);
    const d = call.dispute;
    if (sha256Hex(c.request_canon) !== call.request_hash) throw new CaseError(422, 'request_canon does not match the paid request hash');
    if (sha256Hex(c.response_body) !== d.response_hash) throw new CaseError(422, 'response_body does not match the receipt hash');
    let commit: string;
    try {
      commit = offerCommit(c.buyer_offer_bps, c.salt);
    } catch (e) {
      throw new CaseError(422, (e as Error).message);
    }
    if (commit !== d.buyer_commit) throw new CaseError(422, 'offer and salt do not match the sealed commitment');
    const sellerBps = d.seller_offer_bps ?? 0;
    const base = { call_id: c.call_id, mode: this.o.jurors.mode, request_sha256s: [] as string[], response_sha256s: [] as string[] };

    if (sellerBps >= c.buyer_offer_bps) {
      const out: CaseOutcome = { ...base, tier: 'settled', votes: [], sides: [], winner: null, synthetic: false, submitted: false };
      return this.submit(c, [EMPTY_BALLOT, EMPTY_BALLOT, EMPTY_BALLOT], out);
    }

    const terms = await chain.getTerms(call.seller, call.terms_id);
    if (!terms) throw new CaseError(404, `terms ${call.terms_id} not found`);
    const jurorKeys = (this.o.verifyBallots ?? true) ? (await chain.getJurors()).jurors : [];
    const recs: PanelRecording[] = await Promise.all(JURORS.map(async (j) => {
      const args = {
        juror_idx: j.index, terms_text: terms.text, request_canon: c.request_canon, response_body: c.response_body,
        buyer_bps: c.buyer_offer_bps, seller_bps: sellerBps,
      };
      const body = await chain.buildPanelRequest(args);
      const local = buildPanelRequestFor({
        jurorIndex: j.index, termsText: terms.text, requestCanon: c.request_canon, responseBody: c.response_body,
        buyerOfferBps: c.buyer_offer_bps, sellerOfferBps: sellerBps,
      });
      if (body !== local) throw new CaseError(500, `contract and core disagree on the request body for juror ${j.index}`);
      const model = jurorKeys[j.index]?.model_id ?? j.model;
      const rec = await this.o.jurors.ask(model, body);
      if (this.o.verifyBallots ?? true) assertBallot(rec, jurorKeys[j.index]?.pubkey);
      return rec;
    }));
    const votes = recs.map((r) => parseVote(recordingResponseBody(r)));
    const sides = votes.map((v, i) => voteToSide(i, v));
    const out: CaseOutcome = {
      ...base, tier: 'panel', votes, sides, winner: majority(sides), synthetic: recs.some((r) => r.synthetic === true), submitted: false,
      request_sha256s: recs.map((r) => sha256Hex(r.request_body)),
      response_sha256s: recs.map((r) => sha256Hex(recordingResponseBody(r))),
    };
    if (!out.winner) return { ...out, reason: 'no majority (E_NO_MAJORITY); resolve not submitted' };
    return this.submit(c, recs.map(toContractBallot), out);
  }

  private async submit(c: CaseRequest, ballots: ContractBallot[], out: CaseOutcome): Promise<CaseOutcome> {
    if (this.o.submit === false) return out;
    const tx = await this.o.chain.resolve({
      call_id: c.call_id, buyer_offer_bps: c.buyer_offer_bps, salt: c.salt, request_canon: c.request_canon,
      response_body: c.response_body, ballots,
    });
    return { ...out, submitted: true, txHash: tx.txHash, events: tx.events };
  }
}
