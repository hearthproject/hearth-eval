import { describe, expect, it } from 'vitest';

describe('POST /v1/tasks contract', () => {
  it('returns 429 with Retry-After when rate limited', async () => {
    const response = await callApi({ requestsPerSecond: 11 });
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('replays the first result for the same idempotency-key', async () => {
    const first = await callApi({ idempotencyKey: 'k-1' });
    const second = await callApi({ idempotencyKey: 'k-1' });
    expect(second.body).toEqual(first.body);
  });

  it('rejects an invalid cursor with 400', async () => {
    const response = await callApi({ cursor: 'expired' });
    expect(response.status).toBe(400);
  });
});
