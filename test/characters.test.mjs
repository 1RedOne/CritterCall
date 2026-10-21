import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CHARACTER_PARTS, hashText, characterFromHash, characterFromText } from '../public/characters.mjs';

const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const partKeys = { bodies: 'body', backgrounds: 'background', faces: 'face', accessories: 'accessory', decorations: 'decoration', palettes: 'palette' };

test('SHA-256 uses the exact UTF-8 input, including Unicode and whitespace', async () => {
  assert.equal(await hashText('abc'), HASH);
  assert.equal(await hashText(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const { createHash } = await import('node:crypto');
  for (const text of ['hello', 'Hello', 'hello ', 'こんにちは 🌱', '\u0000']) {
    assert.equal(await hashText(text), createHash('sha256').update(text, 'utf8').digest('hex'));
  }
  assert.notEqual(await hashText('hello'), await hashText('Hello'));
  await assert.rejects(hashText(123), TypeError);
  await assert.rejects(characterFromText(null), TypeError);
});

test('same text, hash and overrides produce byte-for-byte identical scenes', async () => {
  const first = await characterFromText('abc');
  assert.deepEqual(first, await characterFromText('abc'));
  assert.deepEqual(first, characterFromHash(HASH));
  assert.deepEqual(characterFromHash(HASH, { body: 'pear', face: 'wink' }),
    characterFromHash(HASH, { face: 'wink', body: 'pear' }));
  first.traits.body = 'modified';
  first.layers.character = 'modified';
  assert.deepEqual(await characterFromText('abc'), characterFromHash(HASH));
});

test('all named parts are unique, immutable, independently selectable and preserve the hash', () => {
  assert.ok(Object.isFrozen(CHARACTER_PARTS));
  assert.ok(CHARACTER_PARTS.bodies.length >= 8);
  assert.ok(CHARACTER_PARTS.backgrounds.length >= 6);
  assert.ok(CHARACTER_PARTS.faces.length >= 6);
  assert.ok(CHARACTER_PARTS.accessories.length >= 8);
  assert.ok(CHARACTER_PARTS.accessories.includes('none'));
  for (const [plural, singular] of Object.entries(partKeys)) {
    const parts = CHARACTER_PARTS[plural];
    assert.ok(Object.isFrozen(parts));
    assert.equal(new Set(parts).size, parts.length);
    const scenes = parts.map(part => {
      const scene = characterFromHash(HASH, { [singular]: part });
      assert.equal(scene.hash, HASH);
      assert.equal(scene.traits[singular], part);
      return JSON.stringify(scene.layers);
    });
    assert.equal(new Set(scenes).size, parts.length, `${plural} must produce distinct artwork`);
  }
});

test('input guards reject malformed hashes, options, unknown keys and SVG injection', () => {
  for (const bad of [undefined, null, 4, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), HASH.toUpperCase(), `${HASH}\n`]) {
    assert.throws(() => characterFromHash(bad), TypeError);
  }
  for (const bad of [null, [], 42, 'body', new Date(), Object.create({ body: 'pill' })]) {
    assert.throws(() => characterFromHash(HASH, bad), TypeError);
  }
  for (const bad of [{ bodies: 'pill' }, { wat: 'pill' }, { body: undefined }, { body: 'Pill' },
    { body: '<script>alert(1)</script>' }, { background: 'url(https://example.com)' },
    { palette: {} }, { ['__proto__']: 'pill' }, { constructor: 'pill' }, { [Symbol('body')]: 'pill' }]) {
    assert.throws(() => characterFromHash(HASH, bad), TypeError);
  }
  assert.equal(characterFromHash(HASH, Object.create(null)).hash, HASH);
});

test('layers are explicit, aligned, accessible standalone SVGs with only local references', () => {
  const variants = Object.entries(partKeys).flatMap(([plural, singular]) =>
    CHARACTER_PARTS[plural].map(value => characterFromHash(HASH, { [singular]: value })));
  for (const scene of variants) {
    assert.equal(scene.width, 320);
    assert.equal(scene.height, 240);
    assert.deepEqual(Object.keys(scene.layers), ['background', 'character', 'foreground']);
    const allIds = new Set();
    for (const [layer, source] of Object.entries(scene.layers)) {
      assert.match(source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="320" height="240" viewBox="0 0 320 240"/);
      assert.match(source, /<title id="[^"]+">[^<]+<\/title>/);
      assert.match(source, /<desc id="[^"]+">[^<]+<\/desc>/);
      assert.match(source, /<\/svg>$/);
      assert.doesNotMatch(source, /<(?:script|foreignObject|image|iframe|style|animate|set|use)\b|\bon\w+\s*=|\bhref\s*=|data:|javascript:|@import/i);
      assert.doesNotMatch(source.replace('http://www.w3.org/2000/svg', ''), /https?:|\/\/|url\((?!#)/i);
      for (const [, name] of source.matchAll(/\bid="([^"]+)"/g)) {
        assert.ok(!allIds.has(name), `duplicate ID in ${layer}`);
        allIds.add(name);
      }
      for (const [, name] of source.matchAll(/url\(#([^)]+)\)/g)) {
        assert.ok(source.includes(`id="${name}"`), 'references resolve within their own layer');
      }
      const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      assert.equal(decodeURIComponent(encoded.split(',')[1]), source);
      assert.ok(source.length < 13000, 'keep standalone artwork compact');
    }
    assert.doesNotMatch(scene.layers.character, /laptop|wooden desk/);
    assert.match(scene.layers.character, /M105 195Q100 191/);
    assert.doesNotMatch(scene.layers.foreground, /M105 195Q100 191/);
  }
});

test('input text is never reflected into markup and no networking or packages are used', async () => {
  const payload = '"><script>alert("oops")</script><image href="https://evil.invalid"/>';
  const scene = await characterFromText(payload);
  for (const layer of Object.values(scene.layers)) assert.ok(!layer.includes(payload));
  const source = await readFile(new URL('../public/characters.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s|\b(?:fetch|XMLHttpRequest|WebSocket|Math\.random|Date\.now)\s*\(/m);
});

test('deterministic identities explore every part and provide varied combinations', async () => {
  const seen = Object.fromEntries(Object.values(partKeys).map(key => [key, new Set()]));
  const unique = new Set();
  for (let index = 0; index < 384; index++) {
    const scene = await characterFromText(`critter-team-${index}`);
    unique.add(JSON.stringify(scene.traits));
    for (const [key, value] of Object.entries(scene.traits)) seen[key].add(value);
  }
  assert.ok(unique.size > 375);
  for (const [plural, singular] of Object.entries(partKeys)) {
    assert.deepEqual([...seen[singular]].sort(), [...CHARACTER_PARTS[plural]].sort());
  }
});
