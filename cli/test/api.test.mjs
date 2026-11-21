import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountApiClient } from '../src/api.mjs';

test('bearer requests reuse one idempotency key across a retry', async () => {
  const seen = [];
  let attempt = 0;
  const api = new AccountApiClient({
    serverUrl: 'http://example.test/api/v1',
    token: 'fm_pat_fixture',
    fetchImplementation: async (url, init) => {
      seen.push({
        url,
        authorization: init.headers.get('Authorization'),
        idempotencyKey: init.headers.get('Idempotency-Key'),
        body: init.body,
      });
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ code: 'BUSY', message: 'busy' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await api.submitReview({
    sessionId: 'session/id',
    submissionId: 'review-1',
    body: { rating: 'good' },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].idempotencyKey, 'review-1');
  assert.equal(seen[1].idempotencyKey, 'review-1');
  assert.equal(seen[0].body, seen[1].body);
  assert.equal(seen[0].authorization, 'Bearer fm_pat_fixture');
  assert.equal(seen[0].url, 'http://example.test/api/v1/sessions/session%2Fid/reviews');
});
