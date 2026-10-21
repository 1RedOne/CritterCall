import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export function mcpClient(home) {
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../mcp.mjs', import.meta.url))],
    { env: { ...process.env, COPILOT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let counter = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    let response;
    try { response = JSON.parse(line); }
    catch { throw new Error(`Non-JSON MCP stdout: ${line}`); }
    const pending = waiting.get(response.id);
    if (!pending) return;
    waiting.delete(response.id);
    clearTimeout(pending.timer);
    response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result);
  });
  child.on('exit', code => {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP exited (${code}): ${stderr}`));
    }
    waiting.clear();
  });
  function request(method, params = {}) {
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 10000);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    child, request,
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await exited;
      clearTimeout(timer);
    },
  };
}
