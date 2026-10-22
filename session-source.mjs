import { DatabaseSync } from 'node:sqlite';
import { open, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load, CORE_SCHEMA } from './vendor/js-yaml.mjs';
import { copilotHome, sessionIdPattern } from './bridge-store.mjs';

const animals = [
  ['Fox', '\u{1F98A}'], ['Panda', '\u{1F43C}'], ['Frog', '\u{1F438}'],
  ['Otter', '\u{1F9A6}'], ['Koala', '\u{1F428}'], ['Owl', '\u{1F989}'],
  ['Rabbit', '\u{1F430}'], ['Tiger', '\u{1F42F}'], ['Octopus', '\u{1F419}'],
  ['Penguin', '\u{1F427}'], ['Raccoon', '\u{1F99D}'], ['Cat', '\u{1F431}'],
  ['Bear', '\u{1F43B}'], ['Whale', '\u{1F433}'], ['Hedgehog', '\u{1F994}'],
  ['Duck', '\u{1F986}'],
];
const adjectives = ['Rapid', 'Slow', 'Cosmic', 'Sleepy', 'Curious', 'Disco', 'Brave', 'Mellow',
  'Tiny', 'Wobbly', 'Clever', 'Sunny', 'Velvet', 'Bouncy', 'Dreamy', 'Lucky'];

export function character(id) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const [animal, emoji] = animals[hash % animals.length];
  return { name: `${adjectives[(hash >>> 8) % adjectives.length]} ${animal}`, emoji, color: (hash >>> 16) % 8, voice: hash % 7 };
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function projectEvents(events, state = { messages: [], pendingTools: {}, working: false }) {
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'user.message') {
      state.pendingTools = {};
      state.working = true;
    }
    if (['assistant.turn_start', 'tool.execution_start'].includes(event.type)) state.working = true;
    if (['session.idle', 'session.error', 'session.shutdown'].includes(event.type)) state.working = false;
    if (event.type === 'session.error') state.error = data.message || 'Session reported an error.';
    if (event.type === 'assistant.turn_start') state.error = null;
    if (event.type === 'tool.execution_start' && /(?:^|[-_.])ask_user$/.test(data.toolName ?? '')) {
      let args = data.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = { message: args }; }
      }
      state.pendingTools[data.toolCallId] = {
        id: event.id, message: args?.message || args?.question || 'This agent is asking for input in Copilot.',
        createdAt: event.timestamp, kind: 'context', source: 'copilot',
      };
    }
    if (event.type === 'tool.execution_complete') delete state.pendingTools[data.toolCallId];
    if (event.type === 'assistant.message' && typeof data.content === 'string' && data.content.trim()
      && !data.parentToolCallId && !data.toolRequests?.length) {
      state.messages.push({
        id: event.id, message: data.content.slice(0, 12000), createdAt: event.timestamp,
        kind: 'update', source: 'copilot',
      });
      state.messages = state.messages.slice(-8);
    }
  }
  return state;
}

export class SessionSource {
  constructor(home = copilotHome) {
    this.home = home;
    this.cache = new Map();
  }

  async sessionName(id) {
    let source;
    try { source = await readFile(join(this.home, 'session-state', id, 'workspace.yaml'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const document = load(source, { schema: CORE_SCHEMA, onWarning(error) { throw error; } });
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('Workspace metadata must be a mapping.');
    }
    const name = document.name;
    if (name === undefined || name === null || name === '') return;
    if (typeof name !== 'string') throw new Error('Session name must be text.');
    return name.trim() || undefined;
  }

  async events(id) {
    const path = join(this.home, 'session-state', id, 'events.jsonl');
    const info = await stat(path);
    let cached = this.cache.get(id);
    if (!cached || info.size < cached.offset || info.ino !== cached.ino) {
      cached = {
        offset: Math.max(0, info.size - 2 * 1024 * 1024), ino: info.ino,
        partial: '', skipping: info.size > 2 * 1024 * 1024,
        state: { messages: [], pendingTools: {}, working: false },
      };
      this.cache.set(id, cached);
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const events = [];
      // Read a bounded snapshot; the next refresh picks up concurrently appended bytes.
      while (cached.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - cached.offset), cached.offset);
        if (!bytesRead) break;
        cached.offset += bytesRead;
        // Keep bytes, not decoded chunks: a UTF-8 code point can cross a read boundary.
        const chunk = Buffer.concat([Buffer.from(cached.partial, 'base64'), buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== 10) continue;
          if (!cached.skipping) {
            const line = chunk.subarray(start, index).toString('utf8');
            try { if (line.trim()) events.push(JSON.parse(line)); }
            catch { throw new Error(`Invalid complete JSON event in session ${id}.`); }
          }
          cached.skipping = false;
          start = index + 1;
        }
        const rest = chunk.subarray(start);
        if (rest.length > 512 * 1024) {
          cached.skipping = true;
          cached.partial = '';
        } else cached.partial = rest.toString('base64');
      }
      return projectEvents(events, cached.state);
    } catch (error) {
      this.cache.delete(id);
      throw error;
    } finally { await handle.close(); }
  }

  async snapshot(tracked = {}, now = Date.now()) {
    const warnings = [];
    const sessions = new Map();
    const archived = new Set();
    const readCatalog = async (filename, query, merge) => {
      const path = join(this.home, filename);
      try { await stat(path); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      let db;
      try {
        db = new DatabaseSync(path, { readOnly: true });
        db.exec('PRAGMA busy_timeout = 1000');
        for (const row of db.prepare(query).all()) merge(row);
      } catch (error) { warnings.push(`Cannot read ${filename}: ${error.message}`); }
      finally { db?.close(); }
    };
    await readCatalog('session-store.db',
      'SELECT id, summary, repository, cwd, updated_at FROM sessions',
      row => sessions.set(row.id, { id: row.id, title: row.summary || 'Untitled session',
        repository: row.repository || '', cwd: row.cwd || '', updatedAt: row.updated_at }));
    await readCatalog('data.db',
      'SELECT id, title, updated_at, archived_at FROM sessions',
      row => {
        if (row.archived_at) { archived.add(row.id); sessions.delete(row.id); return; }
        const old = sessions.get(row.id) || {};
        sessions.set(row.id, { ...old, id: row.id, title: row.title || old.title || 'Untitled session',
          updatedAt: row.updated_at > (old.updatedAt || '') ? row.updated_at : old.updatedAt });
      });
    for (const [id, entry] of Object.entries(tracked)) {
      if (!sessions.has(id) && !archived.has(id)) {
        sessions.set(id, { id, title: entry.title, repository: entry.repository,
          updatedAt: entry.lastActivityAt });
      }
    }
    let tabs = {};
    let meta = {};
    try { tabs = await optionalJson(join(this.home, 'open-sessions-state.json')); }
    catch (error) { warnings.push(`Cannot read open tabs: ${error.message}`); }
    try { meta = await optionalJson(join(this.home, 'session-meta.json')); }
    catch (error) { warnings.push(`Cannot read session exclusions: ${error.message}`); }
    const candidates = [...sessions.values()].filter(row => sessionIdPattern.test(row.id)
      && !meta[row.id]?.deleted && !meta[row.id]?.archived);
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    for (const row of candidates) {
      row.pinned = tracked[row.id]?.state === 'in-room';
      const activity = Date.parse(row.updatedAt);
      row.lifecycle = row.pinned ? 'in-room'
        : !Number.isFinite(activity) || activity <= cutoff ? 'archived' : tracked[row.id]?.state || 'in-room';
      if (!Number.isFinite(activity) && !row.pinned) {
        warnings.push(`Session ${row.id.slice(0, 8)}: activity time is unavailable; kept in Archive until pinned.`);
      }
    }
    // Open-tab history wins over general history, but is not evidence that a process is still alive.
    const recentlyUsed = row => Math.max(Date.parse(tabs[row.id]?.refreshedAt || row.updatedAt) || 0,
      Date.parse(tracked[row.id]?.updatedAt) || 0);
    candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || Number(Boolean(tabs[b.id])) - Number(Boolean(tabs[a.id])) || recentlyUsed(b) - recentlyUsed(a));
    const pinned = candidates.filter(row => row.pinned);
    const selected = [...pinned,
      ...candidates.filter(row => row.lifecycle === 'in-room' && !row.pinned).slice(0, Math.max(0, 12 - pinned.length)),
      ...candidates.filter(row => row.lifecycle !== 'in-room')];
    const output = await Promise.all(selected.map(async row => {
      try { row.title = await this.sessionName(row.id) || row.title; }
      catch (error) { warnings.push(`Session ${row.id.slice(0, 8)}: cannot read workspace name: ${error.message}`); }
      let state = { messages: [], pendingTools: {}, working: false };
      if (row.lifecycle !== 'archived') {
        try { state = await this.events(row.id); }
        catch (error) {
          warnings.push(`Session ${row.id.slice(0, 8)}: ${error.code === 'ENOENT' ? 'local event history is unavailable' : error.message}`);
        }
      }
      const tab = tabs[row.id];
      const fresh = tab && now - Date.parse(tab.refreshedAt) < 120000;
      const pending = Object.values(state.pendingTools);
      return { ...row, ...character(row.id), messages: [...state.messages, ...pending],
        status: pending.length ? 'needs-context' : fresh && tab.working ? 'working' : 'quiet',
        error: state.error || null, tabHistory: Boolean(tab) };
    }));
    const ids = new Set(selected.map(row => row.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    if (!sessions.size && !warnings.length) warnings.push('No local Copilot sessions found. Open Copilot or try Demo room.');
    return { sessions: output, warnings };
  }
}
