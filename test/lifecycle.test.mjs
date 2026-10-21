import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionTracker } from '../session-tracker.mjs';
import { SessionSource } from '../session-source.mjs';
import { createCallServer } from '../server.mjs';
import { demoSessions } from '../demo.mjs';

const rows = demoSessions();

test('JSON tracker persists resolve/archive/restore and concurrent moves without losing data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-tracker-test-'));
  try {
    const path = join(home, 'session-status.json');
    const tracker = new SessionTracker(path);
    assert.deepEqual(await tracker.read(), { version: 1, sessions: {} });
    await Promise.all([tracker.set(rows[0], 'resolved'), tracker.set(rows[1], 'archived')]);
    let saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.sessions[rows[0].id].state, 'resolved');
    assert.equal(saved.sessions[rows[1].id].state, 'archived');
    assert.equal(saved.sessions[rows[0].id].title, rows[0].title);
    assert.equal(saved.sessions[rows[0].id].messages, undefined);
    const restarted = new SessionTracker(path);
    await restarted.set(rows[0], 'archived');
    await restarted.set(rows[1], 'in-room');
    saved = await restarted.read();
    assert.equal(saved.sessions[rows[0].id].state, 'archived');
    assert.equal(saved.sessions[rows[1].id].state, 'in-room');
    assert.deepEqual(await readdir(home), ['session-status.json']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid state or corrupt tracking JSON is rejected without overwriting it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-tracker-error-test-'));
  try {
    const path = join(home, 'session-status.json');
    const tracker = new SessionTracker(path);
    await assert.rejects(tracker.set(rows[0], 'deleted'), /Unknown session state/);
    await assert.rejects(tracker.set({ id: '../invalid' }, 'resolved'), /UUID/);
    await writeFile(path, '{broken');
    await assert.rejects(tracker.set(rows[0], 'resolved'), /Cannot read/);
    assert.equal(await readFile(path, 'utf8'), '{broken');
    await writeFile(path, '{"version":2,"sessions":{}}');
    await assert.rejects(tracker.read(), /unsupported or invalid format/);
    await writeFile(path, '{"version":1,"sessions":{}}');
    await tracker.set(rows[0], 'resolved');
    assert.equal((await tracker.read()).sessions[rows[0].id].state, 'resolved');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('resolved history survives beyond latest 200; room gets 12 other sessions and restoration is recent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-tracked-history-test-'));
  try {
    const db = new DatabaseSync(join(home, 'session-store.db'));
    db.exec('CREATE TABLE sessions (id TEXT, summary TEXT, repository TEXT, cwd TEXT, updated_at TEXT)');
    for (let index = 1; index <= 220; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(id, `Task ${index}`, 'local/workshop', '',
        new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString());
    }
    db.close();
    const tracked = { [rows[0].id]: { state: 'resolved', title: 'Old title', repository: '',
      updatedAt: new Date().toISOString() } };
    const source = new SessionSource(home);
    const snapshot = await source.snapshot(tracked);
    assert.equal(snapshot.sessions.length, 13);
    assert.equal(snapshot.sessions.find(row => row.id === rows[0].id).title, 'Task 1');
    assert.equal(snapshot.sessions.filter(row => !tracked[row.id]).length, 12);
    tracked[rows[0].id].state = 'archived';
    assert.ok((await source.snapshot(tracked)).sessions.some(row => row.id === rows[0].id));
    tracked[rows[0].id].state = 'in-room';
    const restored = await source.snapshot(tracked);
    assert.equal(restored.sessions.length, 12);
    assert.equal(restored.sessions[0].id, rows[0].id);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('HTTP lifecycle changes persist across restart, are protected, and leave MCP hands intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-lifecycle-http-test-'));
  const options = { home, storePath: join(home, 'bridge.db'), source: {
    async snapshot() { return { sessions: rows, warnings: [] }; },
  } };
  let app = createCallServer(options);
  try {
    let origin = await app.listen(0);
    let snapshot = await (await fetch(`${origin}/api/snapshot`)).json();
    const post = (body, token = snapshot.token) => fetch(`${origin}/api/session-state`, {
      method: 'POST', headers: { Origin: origin, 'X-Call-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const hand = app.store.raise({ sessionId: rows[0].id, message: 'Still waiting' });
    assert.equal((await post({ sessionId: rows[0].id, state: 'resolved' }, 'wrong')).status, 403);
    assert.equal((await post({ sessionId: rows[0].id, state: 'deleted' })).status, 400);
    assert.equal((await post({ sessionId: 'unknown', state: 'resolved' })).status, 404);
    assert.equal((await post({ sessionId: rows[0].id, state: 'resolved' })).status, 200);
    assert.equal(app.store.get(hand.id).status, 'pending');
    await app.close();
    app = createCallServer(options);
    origin = await app.listen(0);
    snapshot = await (await fetch(`${origin}/api/snapshot`)).json();
    assert.equal(snapshot.sessions[0].lifecycle, 'resolved');
    assert.equal((await post({ sessionId: rows[0].id, state: 'archived' })).status, 200);
    assert.equal((await post({ sessionId: rows[0].id, state: 'in-room' })).status, 200);
    const path = join(home, 'critter-call', 'session-status.json');
    const real = await readFile(path, 'utf8');
    assert.equal((await post({ room: 'demo', sessionId: rows[0].id, state: 'resolved' })).status, 200);
    assert.equal(await readFile(path, 'utf8'), real);
    const demo = await (await fetch(`${origin}/api/snapshot?room=demo`)).json();
    assert.equal(demo.sessions[0].lifecycle, 'resolved');
    assert.equal((await (await fetch(`${origin}/api/snapshot`)).json()).sessions[0].lifecycle, 'in-room');
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
