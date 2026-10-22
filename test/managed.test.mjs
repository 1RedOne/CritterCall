import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { ManagedCalls } from '../managed-calls.mjs';
import { createCallServer } from '../server.mjs';

export function fakeRuntimeFactory({ automatic = false } = {}) {
  const runtimes = [];
  const factory = options => {
    const runtime = {
      options, prompts: [], pending: [],
      async initialize() {},
      async create() { runtime.id = randomUUID(); return runtime.id; },
      async load(id) {
        runtime.id = id;
        options.onUpdate({ sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed history must not be duplicated' } } });
      },
      prompt(id, message) {
        runtime.prompts.push(message);
        options.onUpdate({ sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Response: ${message}` } } });
        if (automatic) return Promise.resolve({ stopReason: 'end_turn' });
        return new Promise((resolve, reject) => runtime.pending.push({ resolve, reject }));
      },
      async close() {
        runtime.closed = true;
        for (const waiter of runtime.pending.splice(0)) waiter.reject(new Error('Fixture connection closed'));
      },
      complete() { runtime.pending.shift().resolve({ stopReason: 'end_turn' }); },
      permission() {
        options.onPermission({ sessionId: runtime.id,
          toolCall: { toolCallId: 'fixture-tool', title: 'Write fixture.txt', kind: 'edit', rawInput: { path: 'fixture.txt' } },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
        }, result => { runtime.permissionResult = result; });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
  return { factory, runtimes };
}

async function fixture(t, factoryOptions) {
  const home = await mkdtemp(join(tmpdir(), 'critter-managed-test-'));
  const fake = fakeRuntimeFactory(factoryOptions);
  let manager = new ManagedCalls({ home, runtimeFactory: fake.factory });
  t.after(async () => { await manager.close(); await rm(home, { recursive: true, force: true }); });
  return { home, fake, get manager() { return manager; }, async restart() {
    await manager.close();
    manager = new ManagedCalls({ home, runtimeFactory: fake.factory });
  } };
}
const input = home => ({ operationId: randomUUID(), cwd: home, title: 'Fixture call', message: 'First task' });
async function settle() { await delay(10); }

test('managed calls serialize turns, deduplicate sends/creation, preserve stream output and never take over imported sessions', async t => {
  const f = await fixture(t);
  const options = input(f.home);
  const [first, repeated] = await Promise.all([f.manager.create(options), f.manager.create(options)]);
  assert.equal(first.id, repeated.id);
  assert.equal(f.fake.runtimes.length, 1);
  const runtime = f.fake.runtimes[0];
  assert.equal(f.manager.snapshot()[0].managed.state, 'working');
  assert.match(f.manager.snapshot()[0].messages[1].message, /Response: First task/);
  const second = { messageId: randomUUID(), message: 'Second task' };
  f.manager.enqueue(first.id, second);
  f.manager.enqueue(first.id, second);
  assert.deepEqual(runtime.prompts, ['First task']);
  assert.equal(f.manager.snapshot()[0].managed.queue.length, 1);
  runtime.complete();
  await settle();
  assert.deepEqual(runtime.prompts, ['First task', 'Second task']);
  runtime.complete();
  await settle();
  assert.equal(f.manager.snapshot()[0].managed.state, 'idle');
  assert.throws(() => f.manager.enqueue(first.id, { ...second, message: 'Changed' }), /already in use/);
  assert.throws(() => f.manager.enqueue(randomUUID(), second), /not a Critter-managed/);
  assert.equal((await f.manager.create(options)).id, first.id);
});

test('permission requests require explicit runtime options and cannot be approved through ordinary chat', async t => {
  const f = await fixture(t);
  const call = await f.manager.create(input(f.home));
  const runtime = f.fake.runtimes[0];
  runtime.permission();
  const permission = f.manager.snapshot()[0].managed.permissions[0];
  assert.deepEqual(permission.options.map(option => option.optionId), ['allow', 'deny']);
  f.manager.enqueue(call.id, { messageId: randomUUID(), message: 'approve everything' });
  assert.equal(runtime.permissionResult, undefined);
  assert.throws(() => f.manager.answerPermission(call.id, permission.id, 'always'), /one-operation/);
  assert.throws(() => f.manager.answerPermission(randomUUID(), permission.id, 'allow'), /no longer pending/);
  f.manager.answerPermission(call.id, permission.id, 'deny');
  assert.deepEqual(runtime.permissionResult, { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.throws(() => f.manager.answerPermission(call.id, permission.id, 'allow'), /no longer pending/);
  runtime.complete();
  await settle();
  runtime.complete();
  await settle();
  await f.manager.release(call.id);
  assert.equal(f.manager.snapshot()[0].managed.released, true);
  assert.throws(() => f.manager.enqueue(call.id, { messageId: randomUUID(), message: 'No takeover' }), /released/);
});

test('restart preserves queued messages but never replays an uncertain turn, and release requires cancelling queued work', async t => {
  const f = await fixture(t);
  const call = await f.manager.create(input(f.home));
  const queued = { messageId: randomUUID(), message: 'Keep me queued' };
  f.manager.enqueue(call.id, queued);
  await f.restart();
  assert.equal(f.manager.snapshot()[0].managed.state, 'disconnected');
  assert.equal(f.manager.snapshot()[0].managed.uncertain, true);
  assert.equal(f.manager.snapshot()[0].managed.queue[0].id, queued.messageId);
  await assert.rejects(f.manager.reconnect(call.id), /uncertain delivery/);
  await assert.rejects(f.manager.release(call.id), /Cancel queued/);
  f.manager.cancelMessage(call.id, queued.messageId);
  await f.manager.release(call.id);
  assert.equal(f.fake.runtimes.length, 1);
});

test('cleanly disconnected calls can explicitly reconnect and drain a durable queue without duplicating replayed history', async t => {
  const f = await fixture(t, { automatic: true });
  const call = await f.manager.create(input(f.home));
  await settle();
  await f.restart();
  f.manager.enqueue(call.id, { messageId: randomUUID(), message: 'After restart' });
  assert.equal(f.fake.runtimes.length, 1);
  await f.manager.reconnect(call.id);
  await settle();
  assert.deepEqual(f.fake.runtimes[1].prompts, ['After restart']);
  assert.ok(!f.manager.snapshot()[0].messages.some(row => row.message.includes('Replayed history')));
});

test('invalid folders and unsupported managed IDs fail before creating a runtime; one process owns control', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.create({ ...input(f.home), cwd: 'relative' }), /absolute/);
  const second = new ManagedCalls({ home: f.home, runtimeFactory: f.fake.factory });
  try {
    await assert.rejects(second.create(input(f.home)), /Another Critter Call/);
    assert.equal(f.fake.runtimes.length, 0);
  } finally { await second.close(); }
});

test('idle runtime disconnection clears the connection and allows an explicit reconnect without losing queued messages', async t => {
  const f = await fixture(t, { automatic: true });
  const call = await f.manager.create(input(f.home));
  await settle();
  f.fake.runtimes[0].options.onFault(new Error('Fixture transport dropped'));
  assert.equal(f.manager.snapshot()[0].managed.connected, false);
  assert.match(f.manager.snapshot()[0].managed.error, /transport dropped/);
  f.manager.enqueue(call.id, { messageId: randomUUID(), message: 'Wait for reconnect' });
  await settle();
  assert.equal(f.manager.snapshot()[0].managed.queue.length, 1);
  await f.manager.reconnect(call.id);
  await settle();
  assert.deepEqual(f.fake.runtimes[1].prompts, ['Wait for reconnect']);
});

test('new execution endpoints require the private capability, not public write tokens or forged origins', async t => {
  const home = await mkdtemp(join(tmpdir(), 'critter-control-http-test-'));
  const fake = fakeRuntimeFactory({ automatic: true });
  const app = createCallServer({ home, storePath: join(home, 'bridge.db'),
    source: { async snapshot() { return { sessions: [], warnings: [] }; } },
    managedFactory: options => new ManagedCalls({ ...options, runtimeFactory: fake.factory }),
  });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }); });
  const origin = await app.listen(0);
  const snapshot = await (await fetch(`${origin}/api/snapshot`)).json();
  assert.equal(JSON.stringify(snapshot).includes(app.controlKey), false);
  const post = (path, body, auth, extra = {}) => fetch(`${origin}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Call-Token': snapshot.token,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...extra }, body: JSON.stringify(body) });
  const options = input(home);
  assert.equal((await post('/api/calls/new', options)).status, 401);
  assert.equal((await post('/api/calls/new', options, 'wrong')).status, 401);
  assert.equal((await post('/api/calls/new', options, app.controlKey, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal(fake.runtimes.length, 0);
  const created = await post('/api/calls/new', options, app.controlKey);
  assert.equal(created.status, 201);
  const { sessionId } = await created.json();
  const authorized = await (await fetch(`${origin}/api/snapshot`, { headers: { Authorization: `Bearer ${app.controlKey}` } })).json();
  assert.equal(authorized.controls, true);
  assert.equal(authorized.sessions[0].id, sessionId);
  assert.equal(authorized.sessions[0].pinned, true);
  assert.equal((await (await fetch(`${origin}/api/snapshot`)).json()).sessions.length, 0);
  assert.equal(await readFile(join(home, 'critter-call', 'control-key'), 'utf8'), app.controlKey);
  assert.match(await readFile(join(home, 'critter-call', 'open-controls.html'), 'utf8'), /#control=/);
  assert.equal((await fetch(`${origin}/control-key`)).status, 404);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const navigate = path => new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { headers: navigation }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(await navigate('/'), 200, 'local launcher can navigate to public shell');
  assert.equal(await navigate('/api/snapshot'), 403, 'navigation exception never applies to history/API');
  assert.equal((await post('/api/calls/message', { sessionId: randomUUID(), messageId: randomUUID(), message: 'No hijack' }, app.controlKey)).status, 404);
  assert.equal((await post('/api/calls/new', { ...options, room: 'demo' }, app.controlKey)).status, 409);
});
