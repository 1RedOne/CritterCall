import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../acp-client.mjs';

test('real stdio ACP transport initializes, streams turns, handles explicit permission responses and loads sessions', async () => {
  const updates = [];
  let permission;
  const client = new AcpClient({ command: process.execPath,
    args: [fileURLToPath(new URL('./acp-fixture.mjs', import.meta.url))],
    cwd: process.cwd(), home: process.cwd(), onUpdate: event => updates.push(event),
    onPermission: (params, respond) => { permission = params; respond({ outcome: { outcome: 'selected', optionId: 'deny' } }); },
  });
  try {
    await client.initialize();
    const id = await client.create(process.cwd());
    assert.equal((await client.prompt(id, 'First')).stopReason, 'end_turn');
    assert.equal(updates.map(row => row.update.content.text).join(''), 'Fixture response: First');
    assert.equal((await client.prompt(id, 'Request permission')).stopReason, 'end_turn');
    assert.equal(permission.sessionId, id);
    assert.match(updates.at(-1).update.content.text, /Permission deny/);
    await client.load(id, process.cwd());
    assert.equal(updates.at(-1).update.content.text, 'Replayed fixture history');
    await assert.rejects(client.request('test/malformed', {}), /Invalid ACP response/);
  } finally { await client.close(); }
});

test('missing runtime executable is reported without spawning a shell or hanging the handshake', async () => {
  const client = new AcpClient({ command: 'critter-call-nonexistent-executable',
    cwd: process.cwd(), home: process.cwd() });
  try { await assert.rejects(client.initialize(), /ENOENT/); }
  finally { await client.close(); }
});
