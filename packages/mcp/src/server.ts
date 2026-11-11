import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatUsdc, MCP_SERVER_NAME, PRODUCT_NAME, TOOL_PREFIX } from '@makegood/core';
import { MakegoodClient, MakegoodError, simplePolicy } from '@makegood/buyer';

export const TOOL_CALL = `${TOOL_PREFIX}_call`;
export const TOOL_DISPUTE = `${TOOL_PREFIX}_dispute`;
export const TOOL_STATUS = `${TOOL_PREFIX}_status`;

export interface McpOptions {
  client: MakegoodClient;
  /** Panel service URL used by `dispute` when `submit_to_panel` is set. */
  panelUrl?: string;
}

const text = (obj: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], isError });

function errorResult(e: unknown) {
  if (e instanceof MakegoodError) return text({ error: e.code, message: e.message, call_id: e.callId, contract_code: e.contractCode }, true);
  return text({ error: (e as Error).message, contract_code: (e as { contractCode?: string }).contractCode }, true);
}

/** Buyer-side MCP server: pay for a protected call, dispute it, look up calls and sellers. */
export function createMcpServer(o: McpOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  const c = o.client;

  server.registerTool(TOOL_CALL, {
    description: `Call a ${PRODUCT_NAME}-protected paid HTTP API: pay through the bond contract, retry with proof, verify the seller's signed receipt. Returns the body, the call id and a suggested action.`,
    inputSchema: {
      url: z.string().url(),
      method: z.string().optional(),
      body: z.string().optional(),
      max_price: z.string().regex(/^\d+$/).optional().describe('highest acceptable price in token base units (6 decimals)'),
    },
  }, async (a) => {
    try {
      const r = await c.call(a.url, { method: a.method, body: a.body, maxPrice: a.max_price });
      return text({
        call_id: r.callId, status: r.status, price: formatUsdc(r.price), pay_tx: r.payTx, receipt_verified: true,
        suggested: simplePolicy(r), body: r.body,
      });
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool(TOOL_DISPUTE, {
    description: 'Get money back for a call made in this session: kind "content" opens a panel dispute with a sealed refund offer; "error" claims a refund for a signed 5xx receipt; "non_delivery" claims a call that was paid but not delivered.',
    inputSchema: {
      call_id: z.string(),
      kind: z.enum(['content', 'error', 'non_delivery']).default('content'),
      offer_pct: z.number().int().min(0).max(100).default(100).describe('sealed refund offer for kind=content'),
      submit_to_panel: z.boolean().default(false).describe('wait for the seller to answer, then send the evidence to the panel'),
    },
  }, async (a) => {
    try {
      if (a.kind === 'error') return text({ kind: 'error', tx: (await c.claimError(a.call_id)).txHash });
      if (a.kind === 'non_delivery') return text({ kind: 'non_delivery', tx: (await c.claimNonDelivery(a.call_id)).txHash });
      const d = await c.dispute(a.call_id, { offerBps: a.offer_pct * 100 });
      const out: Record<string, unknown> = { kind: 'content', tx: d.tx.txHash, stake: formatUsdc(d.stake), sealed_offer_pct: a.offer_pct };
      if (a.submit_to_panel) {
        if (!o.panelUrl) throw new Error('no panel URL configured');
        const call = await c.waitForStatus(a.call_id, ['Answered']);
        out.seller_offer_bps = call?.dispute?.seller_offer_bps ?? null;
        out.panel = await c.submitToPanel(o.panelUrl, a.call_id);
      }
      return text(out);
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool(TOOL_STATUS, {
    description: 'Look up a call record (status, dispute) and/or a seller (bond, free capacity, fee, record) on chain.',
    inputSchema: { call_id: z.string().optional(), seller: z.string().optional() },
  }, async (a) => {
    try {
      if (!a.call_id && !a.seller) throw new Error('give call_id or seller');
      const out: Record<string, unknown> = {};
      if (a.call_id) out.call = (await c.chain.getCall(a.call_id)) ?? 'not on chain (released, resolved or never paid)';
      if (a.seller) out.seller = (await c.chain.getSeller(a.seller)) ?? 'not registered';
      return text(out);
    } catch (e) {
      return errorResult(e);
    }
  });

  return server;
}
