import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCallServer } from '../server.mjs';
import { characterFromText } from '../public/characters.mjs';

test('character service matches local generation and returns separate deterministic SVG layers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-art-api-'));
  const app = createCallServer({ home, storePath: join(home, 'bridge.db') });
  try {
    const origin = await app.listen(0);
    const parts = await (await fetch(`${origin}/api/character/parts`)).json();
    assert.ok(parts.bodies.length >= 8);
    const text = 'Rapid Fox \u{1f98a}';
    const hash = createHash('sha256').update(text).digest('hex');
    const response = await fetch(`${origin}/api/character?text=${encodeURIComponent(text)}`);
    assert.equal(response.status, 200);
    const art = await response.json();
    assert.equal(art.hash, hash);
    assert.equal(art.width, 320);
    assert.equal(art.height, 240);
    assert.deepEqual(Object.keys(art.layers).sort(), ['background', 'character', 'foreground']);
    for (const layer of Object.values(art.layers)) {
      assert.match(layer, /<svg\b/);
      assert.match(layer, /viewBox="0 0 320 240"/);
      assert.doesNotMatch(layer, /<script|<foreignObject|\bonload=|https?:\/\/(?!www\.w3\.org)/i);
    }
    assert.deepEqual(art, await characterFromText(text));
    assert.deepEqual(await (await fetch(`${origin}/api/character?hash=${hash}`)).json(), art);
    const overrides = { body: parts.bodies.at(-1), face: parts.faces.at(-1) };
    const overridden = await fetch(`${origin}/api/character`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, overrides }),
    });
    assert.equal(overridden.status, 200);
    assert.deepEqual(await overridden.json(), await characterFromText(text, overrides));
    assert.equal((await fetch(`${origin}/characters.mjs`)).status, 200);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('character API rejects invalid seeds and cross-origin requests without mutating history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-art-errors-'));
  const app = createCallServer({ home, storePath: join(home, 'bridge.db') });
  try {
    const origin = await app.listen(0);
    const post = (body, headers = { Origin: origin }) => fetch(`${origin}/api/character`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const body of [{}, { text: 2 }, { hash: 'bad' }, { text: 'x', hash: '0'.repeat(64) },
      { text: 'x'.repeat(4097) }, { text: 'x', overrides: { body: 'unlisted' } },
      { text: 'x', overrides: { script: '<script>' } }, { text: 'x', overrides: null }]) {
      const result = await post(body);
      assert.equal(result.status, 400, JSON.stringify(body).slice(0, 120));
      assert.equal(typeof (await result.json()).error, 'string');
    }
    assert.equal((await post({ text: 'x' }, {})).status, 403);
    assert.equal((await post({ text: 'x' }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(`${origin}/api/character?text=x`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await post({ text: 'x'.repeat(17000) })).status, 413);
    assert.equal(app.store.list().length, 0);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
