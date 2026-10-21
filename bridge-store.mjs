import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const copilotHome = process.env.COPILOT_HOME || join(homedir(), '.copilot');
export const defaultStorePath = join(copilotHome, 'critter-call', 'bridge.db');
export const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function text(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new InputError(`${label} must be non-empty text, at most ${max} characters.`);
  }
  return value.trim();
}

export class BridgeStore {
  constructor(path = defaultStorePath) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_name TEXT,
        kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
        reply TEXT, replied_at TEXT, dismissed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id, created_at);
    `);
  }

  raise(input) {
    if (!sessionIdPattern.test(input.sessionId)) throw new InputError('A full Copilot session UUID is required.');
    const message = text(input.message, 'Message');
    const kind = input.kind ?? 'question';
    if (!['question', 'context', 'update'].includes(kind)) throw new InputError('Unknown hand kind.');
    const agentName = input.agentName === undefined ? null : text(input.agentName, 'Agent name', 80);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO requests (id, session_id, agent_name, kind, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.sessionId, agentName, kind, message, new Date().toISOString());
    return this.get(id);
  }

  get(id) {
    if (typeof id !== 'string' || !sessionIdPattern.test(id)) throw new InputError('A valid hand request UUID is required.');
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!row) throw new InputError('That hand request no longer exists.', 404);
    return this.project(row);
  }

  project(row) {
    return {
      id: row.id, sessionId: row.session_id, agentName: row.agent_name,
      kind: row.kind, message: row.message, createdAt: row.created_at,
      reply: row.reply, repliedAt: row.replied_at, dismissedAt: row.dismissed_at,
      status: row.replied_at ? 'answered' : row.dismissed_at ? 'dismissed' : 'pending',
    };
  }

  list() {
    // Keep all unanswered hands visible, even if recent history exceeds the display window.
    return this.db.prepare(`SELECT * FROM requests
      WHERE (replied_at IS NULL AND dismissed_at IS NULL)
      OR id IN (SELECT id FROM requests ORDER BY created_at DESC, rowid DESC LIMIT 120)
      ORDER BY created_at, rowid`).all().map(row => this.project(row));
  }

  reply(id, message) {
    this.get(id);
    const reply = text(message, 'Reply');
    const result = this.db.prepare(`UPDATE requests SET reply = ?, replied_at = ?
      WHERE id = ? AND replied_at IS NULL AND dismissed_at IS NULL`)
      .run(reply, new Date().toISOString(), id);
    if (!result.changes) {
      this.get(id);
      throw new InputError('This hand was already answered or dismissed. Refresh before replying.', 409);
    }
    return this.get(id);
  }

  dismiss(id) {
    this.get(id);
    const result = this.db.prepare(`UPDATE requests SET dismissed_at = ?
      WHERE id = ? AND replied_at IS NULL AND dismissed_at IS NULL`)
      .run(new Date().toISOString(), id);
    if (!result.changes) {
      this.get(id);
      throw new InputError('This hand was already answered or dismissed.', 409);
    }
    return this.get(id);
  }

  close() { this.db.close(); }
}
