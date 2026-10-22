import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeStore, InputError, copilotHome } from './bridge-store.mjs';
import { SessionSource } from './session-source.mjs';
import { SessionTracker, sessionStates } from './session-tracker.mjs';
import { demoSessions, seedDemo } from './demo.mjs';
import { CHARACTER_PARTS, characterFromHash, characterFromText } from './public/characters.mjs';
import { ManagedCalls } from './managed-calls.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/audio.mjs', ['audio.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/playground.mjs', ['playground.mjs', 'text/javascript']],
  ['/characters.mjs', ['characters.mjs', 'text/javascript']],
  ['/character-lab', ['character-lab.html', 'text/html']],
  ['/character-lab.css', ['character-lab.css', 'text/css']],
  ['/character-lab.mjs', ['character-lab.mjs', 'text/javascript']],
  ['/notification.mp3', ['notification.mp3', 'audio/mpeg']],
  ['/vendor/animalese.js', ['vendor\\animalese.js', 'text/javascript']],
  ['/vendor/riffwave.js', ['vendor\\riffwave.js', 'text/javascript']],
  ['/vendor/animalese.wav', ['vendor\\animalese.wav', 'audio/wav']],
  ['/vendor/NOTICE.txt', ['vendor\\NOTICE.txt', 'text/plain']],
  ['/vendor/LICENSE.md', ['vendor\\LICENSE.md', 'text/plain']],
]);

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Expected application/json.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new InputError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object');
    return body;
  } catch { throw new InputError('Invalid JSON object.'); }
}

export function createCallServer({ demo = false, storePath, home, source, trackerPath, managedFactory } = {}) {
  const store = new BridgeStore(demo ? ':memory:' : storePath);
  const demoStore = demo ? store : new BridgeStore(':memory:');
  const sessions = source || new SessionSource(home);
  const tracker = new SessionTracker(trackerPath ?? join(home || copilotHome, 'critter-call', 'session-status.json'));
  const demoTracker = new SessionTracker(null);
  seedDemo(demoStore);
  const token = randomBytes(32).toString('hex');
  const controlKey = randomBytes(32).toString('hex');
  const controlDirectory = join(home || copilotHome, 'critter-call');
  const managed = demo ? null : managedFactory ? managedFactory({ home: home || copilotHome })
    : new ManagedCalls({ home: home || copilotHome });
  const authorized = req => {
    const value = req.headers.authorization;
    const expected = `Bearer ${controlKey}`;
    return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected)
      && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  };
  const catalog = async (isDemo, tracked, controls = false) => {
    const snapshot = isDemo ? { sessions: demoSessions(), warnings: [] } : await sessions.snapshot(tracked.sessions);
    if (controls && managed) {
      const rows = new Map(snapshot.sessions.map(session => [session.id, session]));
      for (const call of managed.snapshot()) {
        const history = rows.get(call.id);
        rows.set(call.id, call.managed.released && history
          ? { ...call, ...history, managed: call.managed } : { ...history, ...call });
      }
      snapshot.sessions = [...rows.values()];
    }
    return snapshot;
  };
  let origin;
  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, origin);
      // The local launcher navigates from file:// to the public shell, never an API.
      const entryNavigation = req.method === 'GET' && url.pathname === '/'
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers.host !== new URL(origin).host
        || (!entryNavigation && ((req.headers.origin && req.headers.origin !== origin)
          || req.headers['sec-fetch-site'] === 'cross-site'))) {
        throw new InputError('Only same-origin loopback access is allowed.', 403);
      }
      const path = url.pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [name, type] = assets.get(path);
        const content = await readFile(join(root, 'public', name));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(content);
        return;
      }
      if (req.method === 'GET' && path === '/api/character/parts') {
        send(200, CHARACTER_PARTS);
        return;
      }
      if (path === '/api/character' && ['GET', 'POST'].includes(req.method)) {
        // Character rendering is stateless; unlike replies, it does not mutate local history.
        if (req.method === 'POST' && req.headers.origin !== origin) throw new InputError('A same-origin request is required.', 403);
        const input = req.method === 'POST' ? await jsonBody(req) : Object.fromEntries(url.searchParams);
        if (typeof input.text !== 'string' && typeof input.hash !== 'string') throw new InputError('Provide seed text or a SHA-256 hash.');
        if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 4096)) {
          throw new InputError('Seed text must be a string of at most 4096 characters.');
        }
        if (input.text !== undefined && input.hash !== undefined) throw new InputError('Provide text or hash, not both.');
        let result;
        try {
          result = input.hash !== undefined ? characterFromHash(input.hash, input.overrides)
            : await characterFromText(input.text, input.overrides);
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
          throw new InputError(error.message);
        }
        send(200, result);
        return;
      }
      if (req.method === 'GET' && path === '/api/snapshot') {
        const isDemo = demo || url.searchParams.get('room') === 'demo';
        const tracked = await (isDemo ? demoTracker : tracker).read();
        if (req.headers.authorization && !authorized(req)) throw new InputError('Unlock controls with the current local control key.', 401);
        const controls = !isDemo && authorized(req);
        const snapshot = await catalog(isDemo, tracked, controls);
        send(200, { ...snapshot, sessions: snapshot.sessions.map(session => ({
          ...session, lifecycle: session.lifecycle || tracked.sessions[session.id]?.state || 'in-room',
          pinned: tracked.sessions[session.id]?.state === 'in-room',
        })), requests: (isDemo ? demoStore : store).list(), mode: isDemo ? 'demo' : 'live', token,
          controls, controlKeyFile: join(controlDirectory, 'control-key'),
          bridgeConfig: { mcpServers: { 'critter-call': { command: process.execPath,
            args: ['--disable-warning=ExperimentalWarning', join(root, 'mcp.mjs')], tools: ['*'] } } } });
        return;
      }
      if (req.method === 'POST') {
        const supplied = req.headers['x-call-token'];
        if (req.headers.origin !== origin || typeof supplied !== 'string'
          || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          throw new InputError('Refresh the page before sending a reply.', 403);
        }
        const body = await jsonBody(req);
        const target = demo || body.room === 'demo' ? demoStore : store;
        if (path.startsWith('/api/calls/')) {
          if (target === demoStore || !managed) throw new InputError('Managed calls are not available in Demo room.', 409);
          if (!authorized(req)) throw new InputError('Unlock controls with the local control key first.', 401);
          if (path === '/api/calls/new') {
            const call = await managed.create(body);
            await tracker.set({ id: call.id, title: call.title, updatedAt: call.updated_at, repository: '' }, 'in-room');
            send(201, { sessionId: call.id });
            return;
          }
          if (path === '/api/calls/message') { send(202, managed.enqueue(body.sessionId, body)); return; }
          if (path === '/api/calls/permission') {
            managed.answerPermission(body.sessionId, body.permissionId, body.optionId);
            send(200, { saved: true }); return;
          }
          if (path === '/api/calls/cancel-message') {
            managed.cancelMessage(body.sessionId, body.messageId);
            send(200, { cancelled: true }); return;
          }
          if (path === '/api/calls/reconnect') {
            await managed.reconnect(body.sessionId);
            send(200, { connected: true }); return;
          }
          if (path === '/api/calls/release') {
            await managed.release(body.sessionId);
            send(200, { released: true }); return;
          }
        }
        if (path === '/api/session-state') {
          if (!sessionStates.includes(body.state)) throw new InputError('Unknown session state.');
          const tracking = target === demoStore ? demoTracker : tracker;
          const tracked = await tracking.read();
          const snapshot = await catalog(target === demoStore, tracked, authorized(req));
          const session = snapshot.sessions.find(row => row.id === body.sessionId);
          if (!session) throw new InputError('This session is no longer available. Refresh the room.', 404);
          send(200, await tracking.set(session, body.state));
          return;
        }
        if (path === '/api/reply') { send(200, target.reply(body.requestId, body.message)); return; }
        if (path === '/api/dismiss') { send(200, target.dismiss(body.requestId)); return; }
        if (path === '/api/demo/raise' && target === demoStore) {
          const id = demoSessions().find(row => row.id === body.sessionId)?.id;
          if (!id) throw new InputError('Choose a demo character.');
          send(201, demoStore.raise({ sessionId: id, kind: 'question',
            message: 'Quick check: should I keep going with this approach, or try something different?' }));
          return;
        }
      }
      throw new InputError('Not found.', 404);
    } catch (error) {
      if (!(error instanceof InputError)) console.error('Critter Call:', error);
      if (!res.headersSent) send(error.status || 500, {
        error: error instanceof InputError ? error.message : 'Local data could not be read. See the server terminal for details.',
      });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return {
    server, store, controlKey,
    async listen(port = 47821) {
      await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', done);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      if (!demo) {
        mkdirSync(controlDirectory, { recursive: true });
        writeFileSync(join(controlDirectory, 'control-key'), controlKey, { mode: 0o600 });
        writeFileSync(join(controlDirectory, 'open-controls.html'),
          `<!doctype html><meta http-equiv="refresh" content="0;url=${origin}/#control=${controlKey}"><title>Open Critter Call controls</title>`,
          { mode: 0o600 });
      }
      return origin;
    },
    async close() {
      if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      await managed?.close();
      store.close();
      if (demoStore !== store) demoStore.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 47821);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
  const app = createCallServer({ demo: process.argv.includes('--demo') });
  try { console.log(`Critter Call: ${await app.listen(port)}${process.argv.includes('--demo') ? ' (demo)' : ''}`); }
  catch (error) { await app.close(); throw error; }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
