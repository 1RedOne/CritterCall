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
        new Date(Date.now() - (221 - index) * 60000).toISOString());
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

test('one-week import cutoff archives old threads regardless of tab refresh, without reading archived logs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-age-test-'));
  const now = Date.parse('2026-10-21T16:00:00Z');
  const week = 7 * 24 * 60 * 60 * 1000;
  try {
    const db = new DatabaseSync(join(home, 'session-store.db'));
    db.exec('CREATE TABLE sessions (id TEXT, summary TEXT, repository TEXT, cwd TEXT, updated_at TEXT)');
    const dates = [now - week + 1, now - week, now - week - 1, now, now - week * 2];
    dates.forEach((date, index) => db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
      .run(rows[index].id, `Task ${index}`, '', '', new Date(date).toISOString()));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(rows[5].id, 'Unknown age', '', '', 'invalid');
    db.close();
    await writeFile(join(home, 'open-sessions-state.json'), JSON.stringify({
      [rows[2].id]: { refreshedAt: new Date(now).toISOString(), working: true },
    }));
    const source = new SessionSource(home);
    const readLogs = [];
    source.events = async id => {
      readLogs.push(id);
      return { messages: [], pendingTools: {}, working: false };
    };
    const tracked = {
      [rows[3].id]: { state: 'resolved', updatedAt: new Date(now).toISOString() },
      [rows[4].id]: { state: 'resolved', updatedAt: new Date(now).toISOString() },
    };
    const snapshot = await source.snapshot(tracked, now);
    const states = new Map(snapshot.sessions.map(row => [row.id, row.lifecycle]));
    assert.equal(states.get(rows[0].id), 'in-room', 'one millisecond younger than a week stays in the room');
    for (const index of [1, 2, 4, 5]) assert.equal(states.get(rows[index].id), 'archived');
    assert.equal(states.get(rows[3].id), 'resolved');
    assert.deepEqual(new Set(readLogs), new Set([rows[0].id, rows[3].id]));
    assert.ok(snapshot.warnings.some(message => message.includes('activity time is unavailable')));
    tracked[rows[2].id] = { state: 'in-room', updatedAt: new Date(now).toISOString() };
    const pinned = (await source.snapshot(tracked, now + week)).sessions.find(row => row.id === rows[2].id);
    assert.equal(pinned.lifecycle, 'in-room');
    assert.equal(pinned.pinned, true);
    const missingId = '00000000-0000-4000-8000-000000000099';
    const missing = await source.snapshot({ [missingId]: {
      state: 'resolved', title: 'Missing catalog', repository: '', updatedAt: new Date(now).toISOString(),
    } }, now);
    assert.equal(missing.sessions.find(row => row.id === missingId).lifecycle, 'archived',
      'a recent organizational-state change is not evidence of recent thread activity');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('all older catalog entries reach Archive and every explicit pin remains visible above the twelve-seat default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-many-imports-test-'));
  const now = Date.parse('2026-10-21T16:00:00Z');
  try {
    const db = new DatabaseSync(join(home, 'session-store.db'));
    db.exec('CREATE TABLE sessions (id TEXT, summary TEXT, repository TEXT, cwd TEXT, updated_at TEXT)');
    const tracked = {};
    for (let index = 1; index <= 225; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
        .run(id, `Task ${index}`, '', '', '2026-10-01T12:00:00Z');
      if (index <= 15) tracked[id] = { state: 'in-room', updatedAt: new Date(now).toISOString() };
    }
    db.close();
    const source = new SessionSource(home);
    source.events = async () => ({ messages: [], pendingTools: {}, working: false });
    const snapshot = await source.snapshot(tracked, now);
    assert.equal(snapshot.sessions.length, 225);
    assert.equal(snapshot.sessions.filter(row => row.lifecycle === 'archived').length, 210);
    assert.equal(snapshot.sessions.filter(row => row.lifecycle === 'in-room' && row.pinned).length, 15);
    assert.equal(snapshot.sessions[0].pinned, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('pinning an old imported thread persists across restart and retains its activity timestamp without a catalog', async () => {
  const home = await mkdtemp(join(tmpdir(), 'critter-pin-http-test-'));
  const options = { home, storePath: join(home, 'bridge.db') };
  let app;
  try {
    const db = new DatabaseSync(join(home, 'session-store.db'));
    db.exec('CREATE TABLE sessions (id TEXT, summary TEXT, repository TEXT, cwd TEXT, updated_at TEXT)');
    const activity = '2026-01-01T00:00:00Z';
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(rows[0].id, 'Old call', '', '', activity);
    db.close();
    app = createCallServer(options);
    let origin = await app.listen(0);
    let snapshot = await (await fetch(`${origin}/api/snapshot`)).json();
    assert.equal(snapshot.sessions[0].lifecycle, 'archived');
    const response = await fetch(`${origin}/api/session-state`, {
      method: 'POST', headers: { Origin: origin, 'X-Call-Token': snapshot.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: rows[0].id, state: 'in-room' }),
    });
    assert.equal(response.status, 200);
    await app.close();
    app = createCallServer(options);
    origin = await app.listen(0);
    snapshot = await (await fetch(`${origin}/api/snapshot`)).json();
    assert.equal(snapshot.sessions[0].lifecycle, 'in-room');
    assert.equal(snapshot.sessions[0].pinned, true);
    const tracker = new SessionTracker(join(home, 'critter-call', 'session-status.json'));
    const saved = await tracker.read();
    assert.equal(saved.sessions[rows[0].id].lastActivityAt, activity);
    const edit = new DatabaseSync(join(home, 'session-store.db'));
    edit.exec('DELETE FROM sessions');
    edit.close();
    const source = new SessionSource(home);
    assert.equal((await source.snapshot(saved.sessions)).sessions[0].updatedAt, activity);
    await tracker.set(snapshot.sessions[0], 'resolved');
    assert.equal((await source.snapshot((await tracker.read()).sessions)).sessions[0].lifecycle, 'archived');
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
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
