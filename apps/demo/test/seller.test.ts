import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519FromLabel, HDR_PAYMENT_REQUIRED, toHex } from '@certo/core';
import { FakeChain } from '@certo/core/testing';
import { CertoClient } from '@certo/buyer';
import { startDemoSeller, type DemoSeller } from '../src/seller.js';

const key = ed25519FromLabel('demo-seller-test');
const chain = new FakeChain();
chain.addSeller('honest-api', toHex(key.publicKey));
chain.addTermsFor('honest-api', 'holders-v1', 'terms');
let seller: DemoSeller;
beforeAll(async () => {
  seller = await startDemoSeller({
    id: 'honest-api', chain: chain.as('honest-api'), receiptKey: key, termsId: 'holders-v1', price: '400000',
    responses: { '/v1/holders?token=NEAR&top=5': '{"token":"NEAR"}' },
  });
});
afterAll(async () => { await seller.kill(); });

describe('demo seller', () => {
  it('quotes what it sells; refuses anything else before the 402, so nothing can be paid for a 404', async () => {
    expect((await fetch(`${seller.url}/v1/holders?token=NEAR&top=5`)).status).toBe(402);
    const r = await fetch(`${seller.url}/v1/holders?token=BTC&top=5`);
    expect(r.status).toBe(404);
    expect(r.headers.get(HDR_PAYMENT_REQUIRED)).toBeNull();
    expect(await r.json()).toEqual({
      error: 'not sold here, nothing charged: this demo seller answers only the requests listed in "sold"', sold: ['/v1/holders?token=NEAR&top=5'],
    });
    const before = chain.log.length;
    const err = await new CertoClient({ chain: chain.as('agent') }).call(`${seller.url}/v1/holders?token=BTC&top=5`).catch((e) => e);
    expect(err).toMatchObject({ code: 'NOT_PROTECTED', message: expect.stringMatching(/^expected 402, got 404: .*not sold here, nothing charged/) });
    expect(chain.log.slice(before).filter((l) => l.method === 'pay')).toEqual([]);
  });
});
