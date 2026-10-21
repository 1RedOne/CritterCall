import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { copilotHome, InputError, sessionIdPattern } from './bridge-store.mjs';

export const sessionStates = ['in-room', 'resolved', 'archived'];

export class SessionTracker {
  constructor(path = join(copilotHome, 'critter-call', 'session-status.json')) {
    this.path = path;
    this.memory = { version: 1, sessions: {} };
    this.writes = Promise.resolve();
  }

  async read() {
    if (this.path === null) return structuredClone(this.memory);
    let value;
    try { value = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: {} };
      throw new Error(`Cannot read session-status.json: ${error.message}`);
    }
    if (value?.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)
      || Object.entries(value.sessions).some(([id, entry]) => !sessionIdPattern.test(id)
        || !entry || !sessionStates.includes(entry.state) || !Number.isFinite(Date.parse(entry.updatedAt))
        || typeof entry.title !== 'string' || typeof entry.repository !== 'string')) {
      throw new Error('session-status.json has an unsupported or invalid format. Restore the file before changing session states.');
    }
    return value;
  }

  async set(session, state) {
    if (!sessionIdPattern.test(session?.id)) throw new InputError('A valid session UUID is required.');
    if (!sessionStates.includes(state)) throw new InputError('Unknown session state.');
    // Serialize read/modify/rename operations so simultaneous moves keep both changes.
    const operation = this.writes.then(async () => {
      const data = await this.read();
      data.sessions[session.id] = {
        state, updatedAt: new Date().toISOString(),
        title: session.title || 'Untitled session', repository: session.repository || '',
      };
      if (this.path === null) this.memory = data;
      else {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
          await rename(temporary, this.path);
        } finally { await rm(temporary, { force: true }); }
      }
      return data.sessions[session.id];
    });
    // The caller receives failures; keep the queue usable after a failed operation.
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
