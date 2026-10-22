import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class AcpClient {
  constructor({ cwd, home, model, onUpdate, onPermission, onFault,
    command = process.env.CRITTER_COPILOT || 'copilot', args = [] }) {
    this.pending = new Map();
    this.counter = 0;
    this.closed = false;
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.onFault = onFault;
    this.child = spawn(command, [...args, '--acp', '--stdio', ...(model ? ['--model', model] : [])], {
      cwd, env: { ...process.env, COPILOT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`Copilot exited (${code}). ${this.stderr}`)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(new Error(`Invalid ACP response: ${error.message}`)); this.child.kill(); }
    });
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!this.closed) {
      this.closed = true;
      this.onFault?.(error);
    }
  }

  receive(message) {
    if (this.closed) return;
    if (message.method === 'session/update') {
      this.onUpdate?.(message.params);
    } else if (message.method && message.id !== undefined) {
      const reply = (result, error) => {
        if (!this.closed) this.write({ id: message.id, ...(error ? { error } : { result }) });
      };
      if (message.method === 'session/request_permission') {
        if (this.onPermission) this.onPermission(message.params, result => reply(result));
        else reply({ outcome: { outcome: 'cancelled' } });
      } else {
        reply(undefined, { code: -32601, message: `Critter Call does not implement ${message.method}.` });
        this.onUpdate?.({ sessionId: message.params?.sessionId,
          update: { sessionUpdate: 'critter_notice', text: `Unsupported runtime request: ${message.method}` } });
      }
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message || 'ACP request failed.')) : request.resolve(message.result);
    }
  }

  write(message, callback) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', callback);
  }

  request(method, params, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('Copilot connection is closed.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; delivery may be uncertain.`));
        this.child.kill();
      }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params }, error => { if (error) this.fail(error); });
    });
  }

  async initialize() {
    const result = await this.request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'critter-call', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (result.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version.');
    this.capabilities = result.agentCapabilities || {};
  }

  async create(cwd) {
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    return result.sessionId;
  }

  async load(sessionId, cwd) {
    if (!this.capabilities.loadSession) throw new Error('This Copilot runtime cannot reopen saved sessions.');
    await this.request('session/load', { sessionId, cwd, mcpServers: [] });
  }

  prompt(sessionId, message) {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: message }] }, 0);
  }

  async close() {
    if (this.stopped) return this.stopped;
    this.stopped = new Promise(resolve => {
      this.closed = true;
      this.fail(new Error('Copilot connection closed.'));
      if (this.child.exitCode !== null || !this.child.pid) { resolve(); return; }
      const timer = setTimeout(() => this.child.kill(), 5000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
    return this.stopped;
  }
}
