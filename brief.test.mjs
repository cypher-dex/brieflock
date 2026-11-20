import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FILE_BYTES, base64Size, base64ToBytes, buildPublicPart, bytesToBase64, draftProblem, formatCkb,
  parseBriefPublic, parseSecret, priceToShannons, serializeSecret, verifyFingerprint,
} from './lib/brief.ts';

const draft = {
  title: 'Weekly CKB brief',
  author: 'Karas',
  teaser: 'Three things that happened on Fiber this week.',
  priceCkb: 3,
  body: 'The full brief.',
};

test('a good draft has no problems and each broken rule is reported', () => {
  assert.equal(draftProblem(draft), null);
  assert.match(draftProblem({ ...draft, title: '  ' }), /title/i);
  assert.match(draftProblem({ ...draft, teaser: '' }), /preview/i);
  assert.match(draftProblem({ ...draft, body: '' }), /locked/i);
  for (const priceCkb of [0, 21, 1.5, Number.NaN]) assert.match(draftProblem({ ...draft, priceCkb }), /Price/);
  const big = { name: 'big.bin', type: 'application/octet-stream', base64: bytesToBase64(new Uint8Array(MAX_FILE_BYTES + 1)) };
  assert.match(draftProblem({ ...draft, file: big }), /Attachment/);
});

test('prices convert to shannons and format back', () => {
  assert.equal(priceToShannons(3), 300_000_000n);
  assert.equal(formatCkb(100_100_000n), '1.001');
  assert.equal(formatCkb(200_000_000n), '2');
});

test('the public part commits to the secret and never contains it', async () => {
  const { publicPart, secret } = await buildPublicPart(draft);
  assert.equal(publicPart.title, 'Weekly CKB brief');
  assert.match(publicPart.contentHash, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(publicPart).includes(draft.body), false);
  assert.equal(await verifyFingerprint(secret, publicPart), true);
  assert.equal(await verifyFingerprint(secret.replace('full', 'fake'), publicPart), false);
});

test('attachments round trip and only name and size are public', async () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
  const file = { name: 'data.bin', type: 'application/octet-stream', base64: bytesToBase64(bytes) };
  assert.equal(base64Size(file.base64), 300);
  assert.deepEqual(base64ToBytes(file.base64), bytes);
  const { publicPart, secret } = await buildPublicPart({ ...draft, file });
  assert.deepEqual(publicPart.file, { name: 'data.bin', size: 300 });
  assert.equal(JSON.stringify(publicPart).includes(file.base64), false);
  assert.deepEqual(parseSecret(secret), { body: draft.body, file });
});

test('serialization is stable and malformed secrets are rejected', () => {
  assert.equal(serializeSecret({ body: 'a' }), serializeSecret({ body: 'a' }));
  assert.deepEqual(parseSecret('{"body":"hello"}'), { body: 'hello' });
  for (const bad of ['[]', 'null', '{"body":1}', '{"body":"x","file":{"name":"a"}}']) assert.throws(() => parseSecret(bad));
});

test('pasted offers are validated before the buyer sees them', async () => {
  const { publicPart } = await buildPublicPart(draft);
  assert.deepEqual(parseBriefPublic(JSON.parse(JSON.stringify(publicPart))), publicPart);
  assert.throws(() => parseBriefPublic(undefined), /preview/);
  assert.throws(() => parseBriefPublic({ ...publicPart, priceCkb: 1000 }), /price/i);
  assert.throws(() => parseBriefPublic({ ...publicPart, contentHash: '0x12' }), /fingerprint/i);
  assert.throws(() => parseBriefPublic({ ...publicPart, title: 'x'.repeat(500) }), /title/i);
  assert.throws(() => parseBriefPublic({ ...publicPart, file: { name: 'a', size: MAX_FILE_BYTES + 1 } }), /attachment/i);
});
