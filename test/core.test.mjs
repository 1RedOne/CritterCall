import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { BridgeStore } from '../bridge-store.mjs';
import { SessionSource, character, projectEvents } from '../session-source.mjs';
import { createCallServer } from '../server.mjs';
import { demoSessions } from '../demo.mjs';

const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const event = (type, data = {}, id = 'event-1') => ({ type, data, id, timestamp: '2026-10-20T12:00:00Z' });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'critter-call-test-'));
  t?.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function catalog(home, count = 16) {
  const db = new DatabaseSync(join(home, 'session-store.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, repository TEXT, cwd TEXT, updated_at TEXT)');
  for (let index = 1; index <= count; index++) {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
      .run(uuid(index), `Task ${index}`, 'local/workshop', 'C:\\workshop',
        new Date(Date.now() - (count - index + 1) * 60000).toISOString());
    const dir = join(home, 'session-state', uuid(index));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'events.jsonl'), JSON.stringify(event('assistant.message', { content: `Update ${index}` })) + '\n');
  }
  db.close();
}

test('character identity is deterministic and demo contains exactly 12 distinct sessions', () => {
  assert.deepEqual(character(uuid(1)), character(uuid(1)));
  assert.equal(demoSessions().length, 12);
  assert.equal(new Set(demoSessions().map(row => row.id)).size, 12);
  assert.equal(new Set(demoSessions().map(row => row.name)).size, 12);
});

test('bridge replies are targeted, durable, and cannot be overwritten', async t => {
  const home = await fixture(t);
  const path = join(home, 'bridge.db');
  let store = new BridgeStore(path);
  const first = store.raise({ sessionId: uuid(1), message: 'Need context', agentName: 'Helper A' });
  const second = store.raise({ sessionId: uuid(2), message: 'Need another thing' });
  store.reply(first.id, 'Use the smaller scope');
  assert.equal(store.get(first.id).status, 'answered');
  assert.equal(store.get(second.id).status, 'pending');
  assert.throws(() => store.reply(first.id, 'Overwrite'), /already answered/);
  assert.throws(() => store.dismiss(first.id), /already answered/);
  store.close();
  store = new BridgeStore(path);
  assert.equal(store.get(first.id).reply, 'Use the smaller scope');
  assert.equal(store.get(first.id).agentName, 'Helper A');
  assert.equal(store.list().length, 2);
  store.dismiss(second.id);
  assert.equal(store.get(second.id).status, 'dismissed');
  store.close();
});

test('bridge rejects invalid IDs, empty or oversized text, and invalid hand types', () => {
  const store = new BridgeStore(':memory:');
  try {
    assert.throws(() => store.raise({ sessionId: '../bad', message: 'x' }), /UUID/);
    assert.throws(() => store.raise({ sessionId: uuid(1), message: ' ' }), /non-empty/);
    assert.throws(() => store.raise({ sessionId: uuid(1), message: 'x'.repeat(12001) }), /12000/);
    assert.throws(() => store.raise({ sessionId: uuid(1), message: 'x', kind: 'approval' }), /Unknown/);
    assert.throws(() => store.get(undefined), /UUID/);
    assert.throws(() => store.get(uuid(1)), /no longer exists/);
  } finally { store.close(); }
});

test('one pending hand per agent keeps its ID and latest message until answered or dismissed', async t => {
  const home = await fixture(t);
  const path = join(home, 'bridge.db');
  const firstClient = new BridgeStore(path);
  const secondClient = new BridgeStore(path);
  try {
    const input = { sessionId: uuid(1), message: 'First question', agentName: 'Scope helper' };
    const first = firstClient.raise(input);
    for (let index = 0; index < 5; index++) {
      const repeated = secondClient.raise({ ...input, message: `Latest context ${index}`, kind: 'context' });
      assert.equal(repeated.id, first.id);
      assert.equal(repeated.createdAt, first.createdAt);
      assert.equal(repeated.message, `Latest context ${index}`);
      assert.equal(repeated.kind, 'context');
    }
    assert.equal(firstClient.list().filter(row => row.status === 'pending').length, 1);
    const parent = firstClient.raise({ sessionId: uuid(1), message: 'Parent question' });
    const otherAgent = firstClient.raise({ ...input, agentName: 'Other helper' });
    const otherSession = firstClient.raise({ ...input, sessionId: uuid(2) });
    assert.equal(new Set([first.id, parent.id, otherAgent.id, otherSession.id]).size, 4);
    firstClient.reply(first.id, 'Here is the context');
    const next = secondClient.raise(input);
    assert.notEqual(next.id, first.id);
    assert.throws(() => firstClient.reply(first.id, 'Stale reply'), /already answered/);
    assert.equal(firstClient.get(next.id).status, 'pending');
    secondClient.dismiss(next.id);
    assert.notEqual(secondClient.raise(input).id, next.id);
    assert.equal(firstClient.get(parent.id).status, 'pending');
    assert.equal(firstClient.get(otherAgent.id).status, 'pending');
  } finally {
    firstClient.close();
    secondClient.close();
  }
});

test('legacy duplicate hands share a reply or dismissal without losing old waiter IDs', () => {
  const store = new BridgeStore(':memory:');
  try {
    const insert = store.db.prepare(`INSERT INTO requests (id, session_id, agent_name, kind, message, created_at)
      VALUES (?, ?, ?, 'question', ?, ?)`);
    for (const index of [1, 2, 3]) {
      insert.run(uuid(index + 100), uuid(1), 'Legacy helper', `Old question ${index}`, `2026-10-20T12:00:0${index}Z`);
    }
    const other = store.raise({ sessionId: uuid(1), message: 'Separate question', agentName: 'Other helper' });
    const repeated = store.raise({ sessionId: uuid(1), message: 'Latest question', agentName: 'Legacy helper' });
    assert.equal(repeated.id, uuid(101));
    assert.equal(repeated.message, 'Latest question');
    store.reply(repeated.id, 'One answer to this hand');
    for (const index of [1, 2, 3]) assert.equal(store.get(uuid(index + 100)).reply, 'One answer to this hand');
    assert.equal(store.get(other.id).status, 'pending');
    insert.run(uuid(104), uuid(2), null, 'Old parent question', '2026-10-20T12:00:04Z');
    insert.run(uuid(105), uuid(2), null, 'Another parent question', '2026-10-20T12:00:05Z');
    store.dismiss(uuid(105));
    assert.equal(store.get(uuid(104)).status, 'dismissed');
    assert.equal(store.get(uuid(105)).status, 'dismissed');
  } finally { store.close(); }
});

test('pending hands survive a large answered history', () => {
  const store = new BridgeStore(':memory:');
  try {
    const pending = store.raise({ sessionId: uuid(1), message: 'Still waiting' });
    for (let index = 0; index < 125; index++) {
      const hand = store.raise({ sessionId: uuid(2), message: 'A quick question' });
      store.reply(hand.id, 'Yes');
    }
    assert.ok(store.list().some(row => row.id === pending.id));
  } finally { store.close(); }
});

test('projector distinguishes updates, in-app questions, and resolved questions', () => {
  const state = projectEvents([
    event('assistant.message', { content: 'Visible update' }, 'update'),
    event('assistant.message', { content: 'Not a human update', toolRequests: [{}] }),
    event('tool.execution_start', { toolName: 'functions.ask_user', toolCallId: 'ask-1',
      arguments: { message: 'Which region?' } }, 'ask-event'),
  ]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.pendingTools['ask-1'].message, 'Which region?');
  projectEvents([event('tool.execution_complete', { toolCallId: 'ask-1' })], state);
  assert.equal(Object.keys(state.pendingTools).length, 0);
  projectEvents([event('session.error', { message: 'Connection lost' })], state);
  assert.equal(state.error, 'Connection lost');
});

test('session discovery selects latest 12 tab histories and filters archived or deleted sessions read-only', async t => {
  const home = await fixture(t);
  await catalog(home);
  await writeFile(join(home, 'open-sessions-state.json'), JSON.stringify({
    [uuid(1)]: { refreshedAt: '2026-10-20T12:00:00Z', working: true },
  }));
  await writeFile(join(home, 'session-meta.json'), JSON.stringify({
    [uuid(16)]: { deleted: true }, [uuid(15)]: { archived: true },
  }));
  const before = (await stat(join(home, 'session-store.db'))).mtimeMs;
  const result = await new SessionSource(home).snapshot();
  assert.equal(result.sessions.length, 12);
  assert.equal(result.sessions[0].id, uuid(1));
  assert.equal(result.sessions[1].id, uuid(14));
  assert.ok(!result.sessions.some(row => [uuid(15), uuid(16)].includes(row.id)));
  assert.equal(result.sessions[0].messages[0].message, 'Update 1');
  assert.deepEqual(result.warnings, []);
  assert.equal((await stat(join(home, 'session-store.db'))).mtimeMs, before);
});

test('desktop catalog titles merge with history, while desktop archives stay excluded', async t => {
  const home = await fixture(t);
  await catalog(home, 2);
  const db = new DatabaseSync(join(home, 'data.db'));
  db.exec('CREATE TABLE sessions (id TEXT, title TEXT, updated_at TEXT, archived_at TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(uuid(1), 'Named in the app', '2026-10-20T12:00:00Z', null);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(uuid(2), 'Archived', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z');
  db.close();
  const result = await new SessionSource(home).snapshot();
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].title, 'Named in the app');
  assert.equal(result.sessions[0].repository, 'local/workshop');
});

test('workspace session names override opening-prompt summaries and follow renames without modifying metadata', async t => {
  const home = await fixture(t);
  await catalog(home, 2);
  const path = join(home, 'session-state', uuid(1), 'workspace.yaml');
  const source = new SessionSource(home);
  await writeFile(path, 'name: "Critter Call: improve cards"\nuser_named: true\n');
  let snapshot = await source.snapshot();
  assert.equal(snapshot.sessions.find(row => row.id === uuid(1)).title, 'Critter Call: improve cards');
  assert.equal(snapshot.sessions.find(row => row.id === uuid(2)).title, 'Task 2', 'missing workspace metadata keeps the catalog fallback');
  const renamed = "name: 'Team''s dashboard'\n";
  await writeFile(path, renamed);
  snapshot = await source.snapshot();
  assert.equal(snapshot.sessions.find(row => row.id === uuid(1)).title, "Team's dashboard");
  assert.equal(await readFile(path, 'utf8'), renamed);
  await writeFile(path, 'name: >-\n  Session name\n  across lines\n');
  assert.equal((await source.snapshot()).sessions.find(row => row.id === uuid(1)).title, 'Session name across lines');
  await writeFile(path, 'name: ""\n');
  assert.equal((await source.snapshot()).sessions.find(row => row.id === uuid(1)).title, 'Task 1');
});

test('invalid workspace names warn explicitly while retaining the catalog title', async t => {
  const home = await fixture(t);
  await catalog(home, 1);
  const path = join(home, 'session-state', uuid(1), 'workspace.yaml');
  for (const yaml of ['name: [unterminated', 'name: 42\n', 'name: good\nname: duplicate\n']) {
    await writeFile(path, yaml);
    const snapshot = await new SessionSource(home).snapshot();
    assert.equal(snapshot.sessions[0].title, 'Task 1');
    assert.ok(snapshot.warnings.some(warning => warning.includes('cannot read workspace name')));
  }
});

test('incremental event tail handles partial writes, UTF-8 boundaries, large model events, and truncation', async t => {
  const home = await fixture(t);
  const dir = join(home, 'session-state', uuid(1));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'events.jsonl');
  const source = new SessionSource(home);
  const encoded = Buffer.from(JSON.stringify(event('assistant.message', { content: 'Hello \u{1F98A}' }, 'one')) + '\n');
  const split = encoded.indexOf(Buffer.from('\u{1F98A}')) + 2;
  await writeFile(path, encoded.subarray(0, split));
  assert.equal((await source.events(uuid(1))).messages.length, 0);
  await appendFile(path, encoded.subarray(split));
  assert.equal((await source.events(uuid(1))).messages[0].message, 'Hello \u{1F98A}');
  const giant = JSON.stringify(event('model.messages_snapshot', { text: 'x'.repeat(800000) })) + '\n';
  await appendFile(path, giant + JSON.stringify(event('assistant.message', { content: 'After large model event' }, 'two')) + '\n');
  assert.equal((await source.events(uuid(1))).messages.at(-1).id, 'two');
  await writeFile(path, JSON.stringify(event('assistant.message', { content: 'Truncated log' }, 'three')) + '\n');
  const reset = await source.events(uuid(1));
  assert.equal(reset.messages.length, 1);
  assert.equal(reset.messages[0].id, 'three');
});

test('missing, corrupt, or incompatible local history is reported explicitly', async t => {
  const home = await fixture(t);
  const source = new SessionSource(home);
  assert.match((await source.snapshot()).warnings[0], /No local Copilot/);
  await catalog(home, 1);
  await writeFile(join(home, 'open-sessions-state.json'), 'not json');
  await writeFile(join(home, 'session-state', uuid(1), 'events.jsonl'), '{bad}\n');
  const snapshot = await source.snapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.warnings.length, 2);
});

async function httpFixture(t, options = {}) {
  const home = await fixture();
  const app = createCallServer({ home, storePath: join(home, 'bridge.db'), ...options });
  const origin = await app.listen(0);
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  const snapshot = await (await fetch(`${origin}/api/snapshot`)).json();
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { Origin: origin, 'X-Call-Token': snapshot.token, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { app, origin, snapshot, post };
}

test('HTTP serves assets with restrictive headers and no arbitrary file access', async t => {
  const { origin } = await httpFixture(t);
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(await response.text(), /Critter Call/);
  assert.equal((await fetch(`${origin}/bridge-store.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/snapshot`, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(rebound, 403);
});

test('HTTP routes a reply to exactly one hand and protects writes', async t => {
  const { app, origin, snapshot, post } = await httpFixture(t);
  const first = app.store.raise({ sessionId: uuid(1), message: 'Question A' });
  const second = app.store.raise({ sessionId: uuid(2), message: 'Question B' });
  assert.equal((await post('/api/reply', { requestId: first.id, message: 'A' }, { 'X-Call-Token': 'wrong' })).status, 403);
  assert.equal((await post('/api/reply', { requestId: first.id, message: 'A' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${origin}/api/reply`, { method: 'POST', headers: { 'X-Call-Token': snapshot.token, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const reply = await post('/api/reply', { requestId: first.id, message: 'Answer A' });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).reply, 'Answer A');
  assert.equal(app.store.get(second.id).status, 'pending');
  assert.equal((await post('/api/reply', { requestId: first.id, message: 'Duplicate' })).status, 409);
  assert.equal((await post('/api/reply', { message: 'No ID' })).status, 400);
  assert.equal((await post('/api/reply', { requestId: second.id, message: 'x'.repeat(18000) })).status, 413);
  assert.equal((await post('/api/reply', { requestId: second.id, message: 'A' }, { 'Content-Type': 'text/plain' })).status, 415);
});

test('demo data and demo replies never touch the real reply store', async t => {
  const { app, origin, post } = await httpFixture(t);
  const response = await (await fetch(`${origin}/api/snapshot?room=demo`)).json();
  assert.equal(response.mode, 'demo');
  assert.equal(response.sessions.length, 12);
  assert.equal(response.requests.length, 3);
  assert.equal(app.store.list().length, 0);
  const request = response.requests[0];
  assert.equal((await post('/api/reply', { room: 'demo', requestId: request.id, message: 'Demo answer' })).status, 200);
  assert.equal(app.store.list().length, 0);
  const after = await (await fetch(`${origin}/api/snapshot?room=demo`)).json();
  assert.equal(after.requests.find(row => row.id === request.id).status, 'answered');
});
