import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpClient } from './acp-client.mjs';
import { copilotHome, InputError, sessionIdPattern, text } from './bridge-store.mjs';
import { character } from './session-source.mjs';

const now = () => new Date().toISOString();
function uuid(value) {
  if (typeof value !== 'string' || !sessionIdPattern.test(value)) throw new InputError('A valid operation UUID is required.');
  return value;
}

export class ManagedCalls {
  constructor({ home = copilotHome, runtimeFactory = options => new AcpClient(options) } = {}) {
    this.home = home;
    this.runtimeFactory = runtimeFactory;
    this.connections = new Map();
    this.permissions = new Map();
    this.creating = new Map();
    this.lockPath = join(home, 'critter-call', 'managed.lock');
    this.lockId = randomUUID();
    mkdirSync(join(home, 'critter-call'), { recursive: true });
    this.db = new DatabaseSync(join(home, 'critter-call', 'managed.db'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, operation_id TEXT UNIQUE, cwd TEXT NOT NULL, title TEXT NOT NULL,
        model TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL, stop_reason TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_queue ON messages(session_id, state);
      CREATE TABLE IF NOT EXISTS creations (id TEXT PRIMARY KEY, state TEXT NOT NULL, error TEXT);
    `);
  }

  acquire() {
    if (this.locked) return;
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, id: this.lockId })); }
      finally { closeSync(fd); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid managed-call lock; inspect managed.lock.');
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new InputError('Another Critter Call process owns managed calls.', 409);
      unlinkSync(this.lockPath);
      return this.acquire();
    }
    this.locked = true;
    this.db.exec(`
      UPDATE messages SET state = 'uncertain' WHERE state IN ('dispatching', 'accepted');
      UPDATE calls SET state = 'disconnected', error = 'Server restarted. Reconnect only if this session is not open in Copilot.'
        WHERE state != 'released';
      UPDATE creations SET state = 'uncertain', error = 'Creation was interrupted. Check Copilot history before creating another call.'
        WHERE state = 'starting';
    `);
  }

  get(id) {
    uuid(id);
    const call = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
    if (!call) throw new InputError('This is not a Critter-managed call.', 404);
    return call;
  }

  state(id, state, error = null) {
    this.db.prepare('UPDATE calls SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state, error, now(), id);
  }

  client(call) {
    const connection = { loading: false, running: false };
    connection.runtime = this.runtimeFactory({
      cwd: call.cwd, home: this.home, model: call.model,
      onUpdate: event => {
        if (connection.loading || event.sessionId !== call.id) return;
        const update = event.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && connection.messageId) {
          this.db.prepare(`UPDATE messages SET output = substr(output || ?, 1, 120000), state = 'accepted' WHERE id = ?`)
            .run(update.content.text, connection.messageId);
        }
        if (update?.sessionUpdate === 'critter_notice') this.state(call.id, 'working', update.text);
      },
      onPermission: (params, respond) => {
        if (params.sessionId !== call.id || connection.loading || this.closing) {
          respond({ outcome: { outcome: 'cancelled' } }); return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => this.answerPermission(call.id, id, null), 10 * 60 * 1000);
        const options = (params.options || []).filter(option => ['allow_once', 'reject_once'].includes(option.kind));
        this.permissions.set(id, { id, sessionId: call.id, toolCall: params.toolCall, options, respond, timer });
        this.state(call.id, 'awaiting-permission');
      },
      onFault: error => {
        if (this.closing || this.connections.get(call.id) !== connection) return;
        this.connections.delete(call.id);
        this.cancelPermissions(call.id);
        this.state(call.id, 'disconnected', error.message);
        void connection.runtime.close();
      },
    });
    return connection;
  }

  async create(input) {
    this.acquire();
    const operationId = uuid(input.operationId);
    const existing = this.db.prepare('SELECT id FROM calls WHERE operation_id = ?').get(operationId);
    if (existing) return this.get(existing.id);
    if (this.creating.has(operationId)) return this.creating.get(operationId);
    if (this.db.prepare('SELECT id FROM creations WHERE id = ?').get(operationId)) {
      throw new InputError('This creation was already attempted. Check history before creating another call.', 409);
    }
    const cwdInput = text(input.cwd, 'Project folder', 4096);
    if (!isAbsolute(cwdInput)) throw new InputError('Choose an absolute project folder path.');
    let cwd;
    try { cwd = await realpath(cwdInput); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new InputError('The project folder does not exist.');
      throw error;
    }
    if (!(await stat(cwd)).isDirectory()) throw new InputError('The project folder must be a directory.');
    const title = input.title?.trim() ? text(input.title, 'Call label', 200) : '';
    const model = input.model?.trim() ? text(input.model, 'Model', 120) : '';
    const message = text(input.message, 'Initial message');
    // A second request may have arrived while folder validation was in progress.
    if (this.creating.has(operationId)) return this.creating.get(operationId);
    const created = this.db.prepare('SELECT id FROM calls WHERE operation_id = ?').get(operationId);
    if (created) return this.get(created.id);
    this.db.prepare("INSERT INTO creations (id, state) VALUES (?, 'starting')").run(operationId);
    const operation = (async () => {
      const call = { cwd, model };
      let connection;
      try {
        connection = this.client(call);
        await connection.runtime.initialize();
        call.id = uuid(await connection.runtime.create(cwd));
        this.db.prepare(`INSERT INTO calls VALUES (?, ?, ?, ?, ?, 'idle', NULL, ?, ?)`)
          .run(call.id, operationId, cwd, title || 'New Copilot session', model, now(), now());
        this.connections.set(call.id, connection);
        this.db.prepare("UPDATE creations SET state = 'created' WHERE id = ?").run(operationId);
        this.enqueue(call.id, { messageId: operationId, message });
        return this.get(call.id);
      } catch (error) {
        this.db.prepare("UPDATE creations SET state = 'uncertain', error = ? WHERE id = ?").run(error.message, operationId);
        if (call.id && this.connections.get(call.id) === connection) {
          this.connections.delete(call.id);
          this.state(call.id, 'failed', error.message);
        }
        await connection?.runtime.close();
        throw error;
      } finally { this.creating.delete(operationId); }
    })();
    this.creating.set(operationId, operation);
    return operation;
  }

  enqueue(id, input) {
    this.acquire();
    const call = this.get(id);
    if (call.state === 'released') throw new InputError('This call was released to Copilot and is history-only.', 409);
    const messageId = uuid(input.messageId);
    const message = text(input.message, 'Message');
    const existing = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (existing) {
      if (existing.session_id !== id || existing.body !== message) throw new InputError('Message ID is already in use.', 409);
      return existing;
    }
    this.db.prepare("INSERT INTO messages (id, session_id, body, state, created_at) VALUES (?, ?, ?, 'queued', ?)")
      .run(messageId, id, message, now());
    const connection = this.connections.get(id);
    if (connection) void this.drain(id);
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  }

  async drain(id) {
    const connection = this.connections.get(id);
    if (!connection || connection.running || connection.loading || this.closing) return;
    if (this.db.prepare("SELECT id FROM messages WHERE session_id = ? AND state = 'uncertain'").get(id)) return;
    connection.running = true;
    try {
      let message;
      while (!this.closing && (message = this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND state = 'queued' ORDER BY rowid LIMIT 1").get(id))) {
        connection.messageId = message.id;
        this.state(id, 'working');
        this.db.prepare("UPDATE messages SET state = 'dispatching' WHERE id = ?").run(message.id);
        try {
          const result = await connection.runtime.prompt(id, message.body);
          this.db.prepare("UPDATE messages SET state = 'completed', stop_reason = ? WHERE id = ?").run(result.stopReason, message.id);
          this.cancelPermissions(id);
          if (result.stopReason !== 'end_turn') {
            this.connections.delete(id);
            await connection.runtime.close();
            this.state(id, 'failed', `Turn stopped: ${result.stopReason}. Reconnect to continue queued messages.`);
            break;
          }
          this.state(id, 'idle');
        } catch (error) {
          this.db.prepare("UPDATE messages SET state = 'uncertain' WHERE id = ?").run(message.id);
          this.cancelPermissions(id);
          this.state(id, 'disconnected', `Message delivery is uncertain: ${error.message}. It will not be sent again automatically.`);
          this.connections.delete(id);
          await connection.runtime.close();
          break;
        } finally { connection.messageId = undefined; }
      }
    } finally { connection.running = false; }
  }

  async reconnect(id) {
    this.acquire();
    const call = this.get(id);
    if (call.state === 'released') throw new InputError('Released calls cannot be taken over.', 409);
    if (this.db.prepare("SELECT id FROM messages WHERE session_id = ? AND state = 'uncertain'").get(id)) {
      throw new InputError('An earlier message has uncertain delivery. Review it in Copilot; release this call rather than replaying it.', 409);
    }
    if (this.connections.has(id)) throw new InputError('This call already has a runtime connection.', 409);
    const connection = this.client(call);
    connection.loading = true;
    this.connections.set(id, connection);
    this.state(id, 'starting');
    try {
      await connection.runtime.initialize();
      await connection.runtime.load(id, call.cwd);
      connection.loading = false;
      this.state(id, 'idle');
      void this.drain(id);
    } catch (error) {
      this.connections.delete(id);
      await connection.runtime.close();
      this.state(id, 'failed', error.message);
      throw error;
    }
  }

  answerPermission(sessionId, id, optionId) {
    const permission = this.permissions.get(id);
    if (!permission || permission.sessionId !== sessionId) throw new InputError('This permission request is no longer pending.', 409);
    if (optionId !== null && !permission.options.some(option => option.optionId === optionId)) {
      throw new InputError('Choose one of the runtime-provided one-operation options.');
    }
    clearTimeout(permission.timer);
    this.permissions.delete(id);
    permission.respond({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } });
    if (![...this.permissions.values()].some(row => row.sessionId === sessionId)) this.state(sessionId, 'working');
  }

  cancelPermissions(id) {
    for (const permission of [...this.permissions.values()]) {
      if (permission.sessionId === id) this.answerPermission(id, permission.id, null);
    }
  }

  cancelMessage(id, messageId) {
    this.acquire();
    this.get(id);
    const result = this.db.prepare("UPDATE messages SET state = 'cancelled' WHERE id = ? AND session_id = ? AND state = 'queued'").run(uuid(messageId), id);
    if (!result.changes) throw new InputError('Only a queued, unsent message can be cancelled.', 409);
  }

  async release(id) {
    this.acquire();
    this.get(id);
    if (this.connections.get(id)?.running || this.connections.get(id)?.loading) {
      throw new InputError('Wait for the current turn or reconnect before releasing this call.', 409);
    }
    if (this.db.prepare("SELECT id FROM messages WHERE session_id = ? AND state = 'queued'").get(id)) {
      throw new InputError('Cancel queued messages before releasing this call.', 409);
    }
    const connection = this.connections.get(id);
    this.connections.delete(id);
    this.cancelPermissions(id);
    await connection?.runtime.close();
    this.state(id, 'released');
  }

  snapshot() {
    return this.db.prepare('SELECT * FROM calls ORDER BY created_at').all().map(call => {
      const connected = this.connections.has(call.id);
      const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid').all(call.id);
      const state = !connected && !['released', 'failed'].includes(call.state) ? 'disconnected' : call.state;
      return { id: call.id, title: call.title, cwd: call.cwd, repository: '', updatedAt: call.updated_at,
        ...character(call.id), status: state === 'working' ? 'working' : 'quiet',
        messages: rows.slice(-12).flatMap(row => [
          { id: row.id, message: row.body, createdAt: row.created_at, kind: 'user', user: true, delivery: row.state },
          ...(row.output ? [{ id: `${row.id}-output`, message: row.output
            + (row.output.length >= 120000 ? '\n[Critter Call display limit reached. Full output is in Copilot history.]' : ''), createdAt: row.created_at,
            kind: 'update', source: 'managed' }] : []),
        ]),
        managed: { state, error: call.error, connected, released: state === 'released',
          queue: rows.filter(row => row.state === 'queued').map(row => ({ id: row.id, message: row.body })),
          uncertain: rows.some(row => ['uncertain', 'dispatching', 'accepted'].includes(row.state)) && !connected,
          permissions: [...this.permissions.values()].filter(row => row.sessionId === call.id)
            .map(({ id, toolCall, options }) => ({ id, toolCall, options })),
        },
      };
    });
  }

  async close() {
    if (this.closing) return this.closed;
    this.closed = this.shutdown();
    return this.closed;
  }

  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.creating.values()]);
    for (const id of this.connections.keys()) this.cancelPermissions(id);
    await Promise.all([...this.connections.values()].map(connection => connection.runtime.close()));
    // Prompt rejection handlers finish before the database is closed.
    await new Promise(resolve => setImmediate(resolve));
    if (this.locked && JSON.parse(readFileSync(this.lockPath, 'utf8')).id === this.lockId) unlinkSync(this.lockPath);
    this.db.close();
  }
}
