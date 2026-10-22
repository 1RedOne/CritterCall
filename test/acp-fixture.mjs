import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// Synthetic ACP process. No model, filesystem operations, tools, or credentials.
let sessionId;
let permissionTurn;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = text => send({ method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 'fixture-permission' && !request.method) {
    update(`Permission ${request.result.outcome.optionId || request.result.outcome.outcome}.`);
    send({ id: permissionTurn, result: { stopReason: 'end_turn' } });
    return;
  }
  if (request.method === 'initialize') {
    send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (request.method === 'session/new') {
    sessionId = randomUUID();
    send({ id: request.id, result: { sessionId } });
  } else if (request.method === 'session/load') {
    sessionId = request.params.sessionId;
    update('Replayed fixture history');
    send({ id: request.id, result: {} });
  } else if (request.method === 'session/prompt') {
    const text = request.params.prompt[0].text;
    if (text === 'Request permission') {
      permissionTurn = request.id;
      send({ id: 'fixture-permission', method: 'session/request_permission', params: { sessionId,
        toolCall: { toolCallId: 'edit-1', title: 'Write fixture.txt', kind: 'edit', rawInput: { path: 'fixture.txt' } },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
      } });
    } else {
      update('Fixture response: ');
      setTimeout(() => { update(text); send({ id: request.id, result: { stopReason: 'end_turn' } }); }, 100);
    }
  } else if (request.method === 'test/malformed') {
    process.stdout.write('not protocol json\n');
  } else {
    send({ id: request.id, error: { code: -32601, message: 'Unknown fixture request' } });
  }
});
