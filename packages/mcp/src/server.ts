import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatUsdc, MCP_SERVER_NAME, PRODUCT_NAME, TOOL_PREFIX, type CallView, type SellerView } from '@certo/core';
import {
  CertoError, describeOutcome, describeProgress, disputeAndSettle, helpFor, simplePolicy, type CertoClient, type Outcome, type Progress,
} from '@certo/buyer';

export const TOOL_QUOTE = `${TOOL_PREFIX}_quote`;
export const TOOL_CALL = `${TOOL_PREFIX}_call`;
export const TOOL_DISPUTE = `${TOOL_PREFIX}_dispute`;
export const TOOL_STATUS = `${TOOL_PREFIX}_status`;

export interface McpOptions {
  client: CertoClient;
  /** Panel service URL; content disputes are sent there by default when set (`PANEL_URL`). */
  panelUrl?: string;
  /** Endpoints to try (`CERTO_EXAMPLE_URLS`), named in the server instructions. */
  examples?: Array<{ name: string; url: string }>;
}

const text = (obj: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], isError });
const usdc = (units: string | undefined | null) => (units == null ? undefined : formatUsdc(units));
const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);

function errorResult(e: unknown) {
  const code = e instanceof CertoError ? e.code : undefined;
  const contractCode = (e as { contractCode?: string }).contractCode ?? (e as { code?: string }).code;
  const raw = (e as Error).message;
  // a contract rejection carries the RPC's raw JSON; its E_ code says it in one word (other messages may quote JSON on purpose)
  const message = contractCode?.startsWith('E_') ? raw.replace(/\{.*\}/s, contractCode) : raw;
  return text({
    error: code ?? (contractCode?.startsWith('E_') ? contractCode : message), message, call_id: (e as CertoError).callId, contract_code: contractCode,
    what_to_do: helpFor(code, contractCode),
  }, true);
}

const AMOUNTS = 'All amounts in results are USDC decimal strings (fields ending in _usdc).';
const AMOUNT_IN = 'USDC, e.g. 0.5, "0.50" or "1 USDC" (a JSON number is USDC; a bare integer string such as "500000" is read as base units, 6 decimals)';
const STAKE = 'A dispute (kinds content and non_delivery) locks a stake: max(0.02 USDC, 5% of the price) x your multiplier '
  + '(x2 after each lost content dispute, up to x16; a win halves it); dispute_stake_usdc in certo_quote and certo_call is your exact figure.';

function outcomeJson(o: Outcome) {
  return {
    result: o.result, refund_usdc: usdc(o.refund), stake_back_usdc: usdc(o.stakeBack), stake_lost_usdc: usdc(o.stakeLost), tier: o.tier,
    reason: o.reason, winner: o.winner, votes: o.votes, tx: o.tx, panel: o.panel, summary: describeOutcome(o),
  };
}

function progressJson(p: Progress) {
  if (p.state === 'final') return { state: 'final', outcome: outcomeJson(p.outcome) };
  if (p.state === 'no_dispute') return { state: 'no_dispute', detail: p.detail };
  if (p.state === 'no_panel') {
    return {
      state: 'no_panel', chain_status: p.status, detail: p.detail, next_deadline: iso(p.nextDeadlineMs),
      next: 'nothing changes before next_deadline; after it, call certo_dispute again with the same call_id to settle by the panel-timeout rule',
    };
  }
  return {
    state: 'waiting', chain_status: p.status, detail: p.detail, next_deadline: iso(p.nextDeadlineMs),
    next: 'call certo_dispute again with the same call_id to keep waiting (it does not open a second dispute), or certo_status to look',
  };
}

function callJson(c: CallView) {
  return {
    status: c.status, seller: c.seller, terms_id: c.terms_id, price_usdc: usdc(c.price), fee_usdc: usdc(c.fee), paid_at: iso(c.paid_at_ms),
    refund_window_until: iso(c.expires_at_ms),
    dispute: c.dispute && {
      stake_usdc: usdc(c.dispute.stake), opened_at: iso(c.dispute.opened_at_ms),
      seller_offer_pct: c.dispute.seller_offer_bps == null ? null : c.dispute.seller_offer_bps / 100, answered_at: iso(c.dispute.answered_at_ms),
    },
  };
}

type SellerRecord = Pick<SellerView, 'bond' | 'free_capacity' | 'fee_bps' | 'lifetime_calls' | 'lifetime_losses' | 'lifetime_volume'>;

function sellerJson(s: SellerRecord & { window_ms?: number }) {
  return {
    bond_usdc: usdc(s.bond), free_capacity_usdc: usdc(s.free_capacity), fee_pct: s.fee_bps / 100,
    released_calls: s.lifetime_calls, lost_disputes: s.lifetime_losses, volume_usdc: usdc(s.lifetime_volume),
    ...(s.window_ms ? { refund_window_s: s.window_ms / 1000 } : {}),
  };
}

/** Server instructions: what Certo is, the three-step flow, and the endpoints to try. */
export function instructions(o: Pick<McpOptions, 'examples'>): string {
  const ex = o.examples?.length ? ` Endpoints to try: ${o.examples.map((e) => `${e.name} = ${e.url}`).join('; ')}.` : '';
  return `${PRODUCT_NAME}: paid HTTP API calls with bonded refunds on NEAR. The seller is paid in your own payment transaction; `
    + 'its bond covers your refund for a short window after each call. Flow: certo_quote(url) looks without paying; '
    + 'certo_call(url) pays (refused above CERTO_MAX_PRICE, default 1.00 USDC) and returns the body and a call_id; if the body is '
    + 'an error, missing or wrong, certo_dispute(call_id) before refund_window_until: it waits for the outcome and returns the refund. '
    + `${AMOUNTS}${ex}`;
}

/** Buyer-side MCP server: look, pay, dispute and follow a call to its outcome. */
export function createMcpServer(o: McpOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.2.0' }, { instructions: instructions(o) });
  const c = o.client;
  const examples = o.examples?.length ? ` Try: ${o.examples.map((e) => e.url).join(' , ')}.` : '';

  server.registerTool(TOOL_QUOTE, {
    description: `Look at a ${PRODUCT_NAME}-bonded endpoint without paying: price, the seller's bond and free capacity (what can be refunded `
      + 'right now), fee, record (released calls, lost disputes), refund window, the published terms a dispute is judged against, '
      + 'whether content disputes go to the experimental AI panel ("panel") or are refunded by rule only, '
      + `and the stake a dispute would cost you. "payable": false lists why certo_call would refuse. ${AMOUNTS} `
      + `Errors: NOT_PROTECTED (not a Certo endpoint), NO_SCHEME, WRONG_CONTRACT (another contract than configured).${examples}`,
    inputSchema: { url: z.string().url(), method: z.string().optional(), body: z.string().optional() },
  }, async (a) => {
    try {
      const q = await c.quote(a.url, { method: a.method, body: a.body });
      return text({
        url: q.url, seller: q.seller, price_usdc: usdc(q.price), max_price_usdc: usdc(q.maxPrice), payable: q.problems.length === 0,
        problems: q.problems, fee_pct: q.feeBps / 100, refund_window_s: q.windowMs / 1000, dispute_stake_usdc: usdc(q.disputeStake),
        seller_record: q.seller_record && sellerJson(q.seller_record), terms_id: q.termsId, terms: q.terms,
        panel: q.terms ? (q.terms.panel ? 'experimental: three AI jurors judge content disputes' : 'off: refunds by rule only') : undefined,
      });
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool(TOOL_CALL, {
    description: `Pay for one call to a ${PRODUCT_NAME}-bonded HTTP API and get the response. Pays through the bond contract, retries `
      + "with proof, and checks the seller's signed receipt over the exact bytes. Refused, with nothing paid, above max_price "
      + '(default CERTO_MAX_PRICE, 1.00 USDC). Payment settles in one transaction (a few seconds). Returns body, call_id, http_status, '
      + 'price_usdc, refund_window_until (dispute before then), dispute_stake_usdc, and "suggested" from a demo policy that only checks '
      + `a "token" query parameter ("no_opinion" means judge the body yourself). ${AMOUNTS} Errors before payment (nothing paid): `
      + 'PRICE_TOO_HIGH, WOULD_NOT_FIT (seller bond full), SELLER_UNKNOWN, TERMS_UNKNOWN, NOT_PROTECTED, WRONG_CONTRACT, PAY_FAILED. '
      + 'Errors after payment (call_id set; use certo_dispute kind "non_delivery"): TIMEOUT, NO_RECEIPT, RECEIPT_MISMATCH, BAD_RECEIPT_SIG.'
      + examples,
    inputSchema: {
      url: z.string().url(),
      method: z.string().optional().describe('HTTP method, default GET'),
      body: z.string().optional().describe('request body for POST/PUT'),
      max_price: z.union([z.string(), z.number()]).optional().describe(`highest price to pay for this call: ${AMOUNT_IN}`),
    },
  }, async (a) => {
    try {
      const r = await c.call(a.url, { method: a.method, body: a.body, maxPrice: a.max_price });
      const [view, stake] = await Promise.all([c.chain.getCall(r.callId).catch(() => null), c.stakeFor(r.seller, r.price).catch(() => undefined)]);
      return text({
        call_id: r.callId, http_status: r.status, price_usdc: usdc(r.price), pay_tx: r.payTx, receipt_verified: true,
        refund_window_until: iso(view?.expires_at_ms), dispute_stake_usdc: usdc(stake), suggested: simplePolicy(r), body: r.body,
        next: 'if the body is an error, missing, or not what the terms promise, call certo_dispute with this call_id before refund_window_until',
      });
    } catch (e) {
      return errorResult(e);
    }
  });

  const panelDefault = !!o.panelUrl;
  server.registerTool(TOOL_DISPUTE, {
    description: 'Get money back for a paid call and wait for the final outcome (one call is normally enough). Kinds: '
      + '"content" (default): the body is well-formed but wrong for the terms; opens a dispute with your sealed refund offer, the seller '
      + 'answers with its own offer, then an experimental panel of three AI jurors (NEAR AI TEE models, votes checked by the contract; '
      + 'only when the seller\'s terms enable it, see "panel" in certo_quote) picks the closer offer. '
      + "Lost: your stake is forfeited, you get only the seller's offer, and your next stake doubles. Won: your offer is refunded and the "
      + 'stake comes back. "error": the seller signed an HTTP status >= 500: full refund by rule, no stake, one transaction. '
      + '"rule": the body breaks a published rule of the terms (not JSON, missing required field, stale): full refund by rule, no stake. '
      + '"non_delivery": paid but no valid response (TIMEOUT, NO_RECEIPT, ...); the seller may cure by publishing the signed response '
      + '(you get your stake back, no refund), otherwise a full refund once its answer deadline passes. '
      + `${STAKE} Timing: the seller has a short answer deadline (5 s on the playground); the panel then decides in seconds; `
      + "without a verdict the panel-timeout rule applies after the panel deadline (300 s on the playground): the seller's offer is "
      + 'refunded and your stake returned. The tool waits up to wait_s (default 90) and calls resolve_default itself when a deadline '
      + 'passes; if still open it returns state "waiting": call it again with the same call_id to continue. The playground panel replays '
      + 'recorded answers and knows only a 100% offer on its two example URLs; for any other case it returns at once with state '
      + '"no_panel" and the time the timeout rule settles it. Calls made before a restart work: records and sealed-offer salts '
      + `persist on disk. ${AMOUNTS} `
      + 'Errors: NO_STATE (no record of that call here), E_WINDOW_CLOSED (too late), E_STATUS (already disputed or settled), '
      + 'E_NO_PANEL_TERMS (terms allow no content dispute), E_RULE_NOT_BROKEN, E_HTTP_STATUS (wrong kind for the status code).',
    inputSchema: {
      call_id: z.string(),
      kind: z.enum(['content', 'error', 'rule', 'non_delivery']).default('content'),
      offer_pct: z.number().int().min(0).max(100).default(100).describe('kind=content: the refund you ask for, whole percent of the price (sealed until the verdict)'),
      submit_to_panel: z.boolean().default(panelDefault).describe(`send the evidence and the offer reveal to the panel service once the seller answered (default ${panelDefault}: ${panelDefault ? 'PANEL_URL is set' : 'no PANEL_URL configured'})`),
      wait_s: z.number().int().min(0).max(600).default(90).describe('longest wait for the final outcome, seconds; 0 returns right after opening'),
    },
  }, async (a) => {
    try {
      if (a.submit_to_panel && !o.panelUrl) throw new Error('submit_to_panel needs PANEL_URL');
      const r = await disputeAndSettle(c, a.call_id, {
        kind: a.kind, offerPct: a.offer_pct, panelUrl: a.submit_to_panel ? o.panelUrl : undefined, maxWaitMs: a.wait_s * 1000,
      });
      return text({
        call_id: a.call_id,
        opened: r.opened && { kind: r.opened.kind, tx: r.opened.tx, stake_usdc: usdc(r.opened.stake), sealed_offer_pct: r.opened.sealedOfferPct },
        ...progressJson(r.progress), summary: describeProgress(r.progress),
      });
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool(TOOL_STATUS, {
    description: 'What happened to a call: "open" (refund window still open), "released" (window closed, the seller kept the payment), '
      + '"in_dispute", "refunded" / "partly_refunded" / "not_refunded" / "cured" (final, with amounts), or "unknown" (not on chain and '
      + `no local record: never paid from here). With seller: the seller's bond, free capacity, fee and record. ${AMOUNTS}`,
    inputSchema: { call_id: z.string().optional(), seller: z.string().optional().describe('seller account id, e.g. from certo_quote') },
  }, async (a) => {
    try {
      if (!a.call_id && !a.seller) throw new Error('give call_id or seller');
      const out: Record<string, unknown> = {};
      if (a.call_id) {
        const s = await c.status(a.call_id);
        Object.assign(out, { call_id: a.call_id, state: s.state, detail: s.detail });
        if (s.outcome) out.outcome = outcomeJson(s.outcome);
        if (s.call) out.call = callJson(s.call);
      }
      if (a.seller) {
        const s = await c.chain.getSeller(a.seller);
        out.seller = s ? { id: a.seller, ...sellerJson(s) } : 'not registered';
      }
      return text(out);
    } catch (e) {
      return errorResult(e);
    }
  });

  return server;
}
