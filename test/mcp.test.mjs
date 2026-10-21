import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeStore } from '../bridge-store.mjs';
import { mcpClient } from './mcp-helper.mjs';

test('real stdio MCP handshake, tool discovery, raised hand, and persistent human reply', async t => {
  const home = await mkdtemp(join(tmpdir(), 'critter-mcp-test-'));
  const client = mcpClient(home);
  let reconnect;
  t.after(async () => {
    await client.close();
    await reconnect?.close();
    await rm(home, { recursive: true, force: true });
  });
  const initialized = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.protocolVersion, '2025-06-18');
  assert.equal(initialized.serverInfo.name, 'critter-call');
  const discovered = await client.request('tools/list');
  assert.deepEqual(discovered.tools.map(tool => tool.name), ['raise_hand', 'get_reply']);
  const hand = await client.call('raise_hand', { sessionId: '00000000-0000-4000-8000-000000000001', message: 'Which branch?', agentName: 'Branch helper' });
  assert.equal(hand.status, 'pending');
  assert.equal((await client.call('get_reply', { requestId: hand.id, waitSeconds: 0 })).status, 'pending');
  const store = new BridgeStore(join(home, 'critter-call', 'bridge.db'));
  const waiting = client.call('get_reply', { requestId: hand.id, waitSeconds: 2 });
  store.reply(hand.id, 'Use the feature branch');
  const answer = await waiting;
  assert.equal(answer.reply, 'Use the feature branch');
  assert.equal(answer.status, 'answered');
  store.close();
  await assert.rejects(client.call('raise_hand', { sessionId: 'bad', message: 'Nope' }), /UUID/);
  await assert.rejects(client.call('get_reply', { requestId: hand.id, waitSeconds: -1 }), /waitSeconds/);
  await client.close();
  reconnect = mcpClient(home);
  assert.equal((await reconnect.call('get_reply', { requestId: hand.id, waitSeconds: 0 })).reply, 'Use the feature branch');
});
