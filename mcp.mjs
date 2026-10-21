import { BridgeStore } from './bridge-store.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const store = new BridgeStore();
const tools = [
  {
    name: 'raise_hand',
    description: 'Raise a hand in the local Critter Call page. Use your current Copilot session UUID (from session context/workspace.yaml). agentName identifies a subagent if applicable. This does not replace permission approvals. Call get_reply with the returned requestId to receive the human response.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId', 'message'],
      properties: { sessionId: { type: 'string' }, message: { type: 'string', maxLength: 12000 },
        kind: { type: 'string', enum: ['question', 'context', 'update'], default: 'question' },
        agentName: { type: 'string', maxLength: 80 } } },
  },
  {
    name: 'get_reply',
    description: 'Read the human response to your hand. Waits up to 25 seconds without busy-polling. A pending result is NOT an answer. Dismissed means the human explicitly dismissed the request. Stop polling if cancelled.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'],
      properties: { requestId: { type: 'string' }, waitSeconds: { type: 'integer', minimum: 0, maximum: 25, default: 25 } } },
  },
];
const controllers = new Map();
let input = '';
let active = 0;
let ended = false;
const write = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);

async function dispatch(request) {
  if (request.method === 'notifications/cancelled') {
    controllers.get(request.params?.requestId)?.abort();
    return;
  }
  if (request.id === undefined) return;
  const controller = new AbortController();
  controllers.set(request.id, controller);
  active++;
  try {
    let result;
    if (request.method === 'initialize') result = {
      protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(request.params?.protocolVersion)
        ? request.params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'critter-call', version: '0.1.0' },
    };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      const args = request.params?.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
      let value;
      if (request.params.name === 'raise_hand') value = store.raise(args);
      else if (request.params.name === 'get_reply') {
        if (typeof args.requestId !== 'string') throw new Error('requestId is required.');
        const seconds = args.waitSeconds ?? 25;
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 25) throw new Error('waitSeconds must be 0..25.');
        const deadline = Date.now() + seconds * 1000;
        do {
          value = store.get(args.requestId);
          if (value.status !== 'pending' || Date.now() >= deadline) break;
          await delay(Math.min(250, deadline - Date.now()), undefined, { signal: controller.signal });
        } while (true);
      } else throw new Error('Unknown tool.');
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } else {
      write({ id: request.id, error: { code: -32601, message: 'Method not found.' } });
      return;
    }
    write({ id: request.id, result });
  } catch (error) {
    if (request.method === 'tools/call') write({ id: request.id,
      result: { isError: true, content: [{ type: 'text', text: error.name === 'AbortError' ? 'Request cancelled.' : error.message }] } });
    else write({ id: request.id, error: { code: -32602, message: error.message } });
  } finally {
    controllers.delete(request.id);
    active--;
    if (ended && active === 0) store.close();
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    if (!line.trim()) continue;
    if (line.length > 65536) {
      write({ id: null, error: { code: -32600, message: 'Request exceeds 64 KiB.' } });
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('Invalid request');
    } catch {
      write({ id: null, error: { code: -32700, message: 'Invalid JSON-RPC request.' } });
      continue;
    }
    void dispatch(request);
  }
  if (input.length > 65536) {
    console.error('Critter Call MCP input exceeds 64 KiB.');
    process.exitCode = 1;
    process.stdin.destroy();
  }
});
process.stdin.on('end', () => {
  ended = true;
  for (const controller of controllers.values()) controller.abort();
  if (active === 0) store.close();
});
