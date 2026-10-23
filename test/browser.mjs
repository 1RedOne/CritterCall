import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createCallServer } from '../server.mjs';
import { demoSessions } from '../demo.mjs';
import { mcpClient } from './mcp-helper.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManagedCalls } from '../managed-calls.mjs';
import { AcpClient } from '../acp-client.mjs';

const home = await mkdtemp(join(tmpdir(), 'critter-browser-test-'));
let app;
let browser;
let cdp;
let client;
let browserExited = false;
const errors = [];
const stderr = [];
const fixtureState = { sessions: demoSessions().map(row => ({ ...row, demo: false })) };

class DevTools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.id = 0;
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}

async function waitFor(expression, description, milliseconds = 10000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Browser check timed out: ${description}`);
}

async function clickPoint(x, y, clickCount = 1) {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}

async function pressKey(key, windowsVirtualKeyCode) {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
}

async function openContextMenu(selector) {
  const { x, y } = await cdp.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    target.scrollIntoView({block: 'center', inline: 'nearest'});
    const rect = target.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await waitFor("!document.getElementById('session-menu').hidden", 'native right-click opens agent actions');
}

try {
  const executable = process.env.CRITTER_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  await access(executable);
  app = createCallServer({ home, storePath: join(home, 'critter-call', 'bridge.db'),
    managedFactory: options => new ManagedCalls({ ...options, runtimeFactory: config => new AcpClient({
      ...config, command: process.execPath, args: [fileURLToPath(new URL('./acp-fixture.mjs', import.meta.url))],
    }) }),
    source: { async snapshot() { return { sessions: fixtureState.sessions, warnings: [] }; } } });
  const origin = await app.listen(0);
  const profile = join(home, 'browser-profile');
  browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.on('exit', () => { browserExited = true; });
  browser.stderr.on('data', chunk => { stderr.push(String(chunk)); });
  let port;
  for (let index = 0; index < 100; index++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
    if (browserExited) throw new Error(`Browser exited early: ${stderr.join('').slice(-2000)}`);
    await delay(100);
  }
  assert.ok(port, `No DevTools port: ${stderr.join('').slice(-2000)}`);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new DevTools(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: `${origin}/?demo=1` });
  await waitFor("document.querySelectorAll('.tile').length === 12", '12 demo participants');
  assert.equal(await cdp.evaluate("document.getElementById('room-title')"), null, 'Decorative workshop heading no longer uses vertical space');
  assert.equal(await cdp.evaluate("document.getElementById('new-call').hidden"), true, 'Demo cannot start real agents');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.tile.hand').length"), 3);
  assert.equal(await cdp.evaluate("document.querySelector('.tile .session-name').textContent"), demoSessions()[0].title);
  assert.equal(await cdp.evaluate("document.querySelector('.tile .critter-badge').textContent"), demoSessions()[0].name);
  assert.equal(await cdp.evaluate("document.getElementById('conversation-title').textContent"), demoSessions()[0].title);
  assert.equal(await cdp.evaluate("document.getElementById('selected-title').textContent"), demoSessions()[0].name);
  assert.ok(await cdp.evaluate(`(() => {
    const tile = document.querySelector('.tile.hand');
    const style = getComputedStyle(tile);
    return style.borderTopColor === 'rgb(255, 179, 71)'
      && style.animationName === 'hand-glow'
      && getComputedStyle(tile.querySelector('.hand-badge')).animationName === 'hand-wave';
  })()`), 'Raised hands retain an orange border and animated glow/badge even when selected');
  assert.equal(await cdp.evaluate("document.getElementById('source-badge').textContent"), 'Demo bridge');
  await waitFor("[...document.querySelectorAll('.tile .scene-layer')].every(image => image.complete && image.naturalWidth > 0)", 'all SVG character layers render');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.tile .scene-layer').length"), 36);
  const firstArtwork = await cdp.evaluate("document.querySelector('.tile .character-scene').dataset.hash");
  assert.match(firstArtwork, /^[a-f0-9]{64}$/);
  await cdp.evaluate(`window.playedAudio = []; window.playedMetrics = []; window.audioEvents = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      window.playedAudio.push(this);
      const metric = { duration: this.duration };
      window.playedMetrics.push(metric);
      this.addEventListener('loadedmetadata', () => { metric.duration = this.duration; }, { once: true });
      const kind = this.src.endsWith('/notification.mp3') ? 'bell' : 'voice';
      window.audioEvents.push({ kind, event: 'start', at: performance.now(), rate: this.playbackRate, metric });
      this.addEventListener('ended', () => window.audioEvents.push({ kind, event: 'end', at: performance.now() }), { once: true });
      return original.call(this);
    };`);
  await delay(300);
  assert.equal(await cdp.evaluate("window.playedAudio.length"), 0, 'Initial historical hands do not announce');
  await cdp.evaluate(`
    document.querySelector('.tile').click();`);
  await waitFor("window.playedAudio.length > 0 && !!document.querySelector('.tile.speaking')", 'animalese.js audio starts');
  assert.ok(await cdp.evaluate("window.playedAudio[0].src.startsWith('data:audio/wav;base64,')"));
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.tile.speaking .character-layer')).animationName"), 'blob-talk');
  assert.ok(await cdp.evaluate("[...document.querySelectorAll('.background-layer, .foreground-layer')].every(node => getComputedStyle(node).animationName === 'none')"), 'Only the character layer animates');
  await cdp.evaluate("document.getElementById('stop-audio').click()");
  await waitFor("!document.querySelector('.tile.speaking')", 'audio can be interrupted');
  const firstCount = await cdp.evaluate('window.playedAudio.length');
  await cdp.evaluate("document.querySelector('.tile').click()");
  await delay(250);
  assert.equal(await cdp.evaluate('window.playedAudio.length'), firstCount, 'Repeated card clicks do not re-read the message');
  const excerptPlayback = await cdp.evaluate(`(async () => {
    const { CritterVoice, spokenExcerpt } = await import('/audio.mjs');
    const text = 'Earlier details. '.repeat(40) + 'Ready now. Looks good! Need help?';
    let started = false;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const preview = new CritterVoice(value => {
      if (value) started = true;
      else if (started) finish();
    }, message => { throw new Error(message); });
    await preview.play(text, '0'.repeat(64), 'chatter');
    await done;
    const spoken = spokenExcerpt(text);
    return { spoken, actual: window.playedMetrics.at(-1).duration,
      expected: spoken.length * Math.floor(.075 * 44100) / 44100 };
  })()`);
  assert.equal(excerptPlayback.spoken, 'Ready now. Looks good! Need help?');
  assert.ok(Math.abs(excerptPlayback.actual - excerptPlayback.expected) < .003,
    `Animalese WAV duration must cover only the last three sentences: ${JSON.stringify(excerptPlayback)}`);
  await cdp.evaluate("document.querySelector('.tile:not(.hand)').click()");
  await cdp.evaluate("document.getElementById('stop-audio').click(); window.audioEvents = []; window.playedAudio = []; document.getElementById('demo-hand').click()");
  await waitFor("window.audioEvents.some(event => event.kind === 'bell' && event.event === 'start')", 'new hand plays notification bell');
  assert.equal(await cdp.evaluate("!!document.querySelector('.tile.speaking')"), false, 'Bell does not animate speech');
  await waitFor("window.audioEvents.some(event => event.kind === 'voice' && event.event === 'start')", 'agent name follows bell', 15000);
  const bellSequence = await cdp.evaluate(`(() => {
    const bell = window.audioEvents.find(event => event.kind === 'bell' && event.event === 'end');
    const start = window.audioEvents.find(event => event.kind === 'bell' && event.event === 'start');
    const voice = window.audioEvents.find(event => event.kind === 'voice' && event.event === 'start');
    return { bell, start, voice };
  })()`);
  assert.ok(bellSequence.bell && bellSequence.voice.at >= bellSequence.start.at + bellSequence.start.metric.duration * 1000 - 50
    && bellSequence.start.rate === 1, `Bell finishes before the deterministic agent voice begins: ${JSON.stringify(bellSequence)}`);
  assert.equal(await cdp.evaluate("document.querySelectorAll('.spoken-excerpt').length"), 0, 'Announcing a name does not highlight unrelated transcript text');
  const announced = await cdp.evaluate(`(async () => {
    const { voiceFromHash } = await import('/audio.mjs');
    const tile = document.querySelector('.tile.selected');
    const name = tile.querySelector('.critter-badge').textContent;
    return { name, hash: tile.querySelector('.character-scene').dataset.hash,
      rate: window.playedAudio.at(-1).playbackRate,
      duration: window.playedAudio.at(-1).duration,
      profile: voiceFromHash(tile.querySelector('.character-scene').dataset.hash) };
  })()`);
  assert.equal(announced.rate, announced.profile.rate);
  assert.ok(Math.abs(announced.duration - announced.name.length * Math.floor(.075 * 44100) / 44100) < .003, 'Notification reads only the agent name');
  await waitFor("!document.querySelector('.tile.speaking')", 'name announcement completes');
  const alertCount = await cdp.evaluate('window.playedAudio.length');
  await cdp.evaluate("window.unchangedTile = document.querySelector('.tile').parentElement.children[4]");
  await delay(2200);
  assert.equal(await cdp.evaluate('window.playedAudio.length'), alertCount, 'Polling does not repeat a hand notification');
  assert.ok(await cdp.evaluate("document.querySelectorAll('.tile')[4] === window.unchangedTile"), 'Unchanged cards retain their DOM and animation across polls');
  await cdp.evaluate("document.getElementById('demo-hand').click()");
  await delay(2200);
  assert.equal(await cdp.evaluate('window.playedAudio.length'), alertCount, 'Raising the same pending hand does not replay its notification');
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected .hand-badge').textContent"), '\u270B Hand raised');
  assert.equal((await (await fetch(`${origin}/api/snapshot?room=demo`)).json()).requests.length, 4);
  assert.equal(await cdp.evaluate("document.querySelector('.tile .character-scene').dataset.hash"), firstArtwork, 'Character identity survives refresh');
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.ok(await cdp.evaluate("[...document.querySelectorAll('.scene-layer')].every(node => getComputedStyle(node).animationName === 'none')"), 'Reduced motion disables character animation');
  assert.ok(await cdp.evaluate("[...document.querySelectorAll('.tile.hand, .hand-badge')].every(node => getComputedStyle(node).animationName === 'none')"), 'Reduced motion disables hand glows and waving badges too');
  await cdp.call('Emulation.setEmulatedMedia', { features: [] });
  await cdp.evaluate("document.querySelector('.tile').click()");
  await cdp.evaluate(`document.getElementById('sound').value = 'off';
    var reply = document.getElementById('reply'); reply.value = 'Grid view, please!';
    reply.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('reply-form').requestSubmit();`);
  await waitFor("document.querySelector('.message.user .message-text')?.textContent === 'Grid view, please!'", 'demo reply appears in transcript');
  assert.equal(app.store.list().length, 0);
  const demoData = await (await fetch(`${origin}/api/snapshot?room=demo`)).json();
  assert.ok(demoData.requests.some(request => request.reply === 'Grid view, please!'));
  await cdp.evaluate("document.getElementById('connect').click()");
  assert.equal(await cdp.evaluate("document.getElementById('setup').open"), true);
  assert.match(await cdp.evaluate("document.getElementById('bridge-config').textContent"), /mcp\.mjs/);
  await cdp.evaluate("document.getElementById('close-setup').click()");
  if (process.env.CRITTER_SCREENSHOT) {
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(process.env.CRITTER_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile room must not overflow horizontally');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });

  client = mcpClient(home);
  await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-test', version: '1' } });
  const sessionId = demoSessions()[0].id;
  const lastSentences = 'Use the local scope. The checks are ready. Which scope should I use?';
  const fullMessage = `Earlier context. An older update. ${lastSentences}`;
  const hand = await client.call('raise_hand', { sessionId, message: fullMessage, kind: 'context', agentName: 'Scope helper' });
  for (let index = 0; index < 5; index++) {
    assert.equal((await client.call('raise_hand', { sessionId, message: fullMessage, kind: 'context', agentName: 'Scope helper' })).id, hand.id);
  }
  await cdp.call('Page.navigate', { url: origin });
  await waitFor("document.getElementById('source-badge').textContent === 'Reply bridge'", 'real stdio bridge hand appears');
  const renamedTitle = 'A renamed Copilot session with a descriptive title';
  fixtureState.sessions[0].title = renamedTitle;
  await waitFor("document.querySelector('.tile.selected .session-name')?.textContent === " + JSON.stringify(renamedTitle), 'session rename updates the primary card label');
  assert.equal(await cdp.evaluate("document.getElementById('conversation-title').textContent"), renamedTitle);
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected .critter-badge').textContent"), demoSessions()[0].name);
  assert.equal(await cdp.evaluate("document.querySelector('.message.active .message-text').textContent"), fullMessage);
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected .hand-badge').textContent"), '\u270B Hand raised');
  assert.equal(await cdp.evaluate("document.getElementById('hand-count').textContent"), '1 hand raised');
  assert.equal(await cdp.evaluate("document.getElementById('request-picker').hidden"), true);
  await cdp.evaluate("document.querySelector('.tile').click()");
  await waitFor("document.querySelector('.spoken-excerpt')?.textContent === " + JSON.stringify(lastSentences), 'only the last three sentences receive subtle highlighting');
  const firstWord = await cdp.evaluate("document.querySelector('.spoken-word')?.textContent");
  assert.ok(firstWord);
  await waitFor("!!document.querySelector('.spoken-word') && document.querySelector('.spoken-word').textContent !== " + JSON.stringify(firstWord), 'word highlight advances with Animalese playback');
  assert.equal(await cdp.evaluate("document.querySelector('.message.active .message-text').textContent"), fullMessage, 'Highlighting must preserve the full transcript');
  await cdp.evaluate("document.getElementById('stop-audio').click()");
  assert.equal(await cdp.evaluate("document.querySelectorAll('.spoken-excerpt, .spoken-word').length"), 0, 'Stopping clears playback highlights');
  await cdp.evaluate("document.getElementById('sound').value = 'off'");
  await cdp.evaluate(`var reply = document.getElementById('reply'); reply.value = 'Only the local workshop.';
    reply.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('reply-form').requestSubmit();`);
  await waitFor("document.querySelector('.message.user .message-text')?.textContent === 'Only the local workshop.'", 'live bridge reply appears');
  assert.equal((await client.call('get_reply', { requestId: hand.id, waitSeconds: 0 })).reply, 'Only the local workshop.');
  await waitFor("document.getElementById('send').textContent.includes('Copy for Copilot')", 'history-only state does not claim a live send path');
  const second = await client.call('raise_hand', { sessionId, message: 'Question two', agentName: 'Helper two' });
  const third = await client.call('raise_hand', { sessionId, message: 'Question three', agentName: 'Helper three' });
  await waitFor("document.querySelectorAll('#request-picker button').length === 2", 'multiple concurrent hands arrive');
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected .hand-badge').textContent"), '\u270B 2 hands');
  await openContextMenu('.tile.selected');
  assert.equal(await cdp.evaluate("document.getElementById('menu-dismiss-hand').textContent"), 'Dismiss Hand: Helper two');
  await delay(2200);
  assert.equal(await cdp.evaluate("document.activeElement.id"), 'menu-dismiss-hand', 'polling keeps keyboard focus in the context menu rather than the request picker');
  await cdp.evaluate("document.getElementById('session-menu').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))");
  await cdp.evaluate(`var reply = document.getElementById('reply'); reply.value = 'Draft for two'; reply.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('#request-picker button')[1].click();`);
  assert.equal(await cdp.evaluate("document.getElementById('reply').value"), '');
  await cdp.evaluate("document.querySelectorAll('#request-picker button')[0].click()");
  assert.equal(await cdp.evaluate("document.getElementById('reply').value"), 'Draft for two');
  await cdp.evaluate("document.getElementById('reply-form').requestSubmit()");
  await waitFor("document.querySelector('.message.user:last-of-type .message-text')?.textContent === 'Draft for two' || [...document.querySelectorAll('.message.user')].some(x => x.textContent.includes('Draft for two'))", 'reply routes to the chosen concurrent hand');
  assert.equal((await client.call('get_reply', { requestId: second.id, waitSeconds: 0 })).reply, 'Draft for two');
  assert.equal((await client.call('get_reply', { requestId: third.id, waitSeconds: 0 })).status, 'pending');
  await waitFor("document.querySelector('.message.active .message-text')?.textContent === 'Question three'", 'next pending hand becomes reply target');
  const otherSessionId = fixtureState.sessions[1].id;
  const otherHand = await client.call('raise_hand', { sessionId: otherSessionId, message: 'Dismiss me from another card', agentName: 'Other helper' });
  const retainedHand = await client.call('raise_hand', { sessionId: otherSessionId, message: 'Keep this other hand pending', agentName: 'Retained helper' });
  await waitFor(`document.querySelector('.tile[data-id="${otherSessionId}"] .hand-badge')?.textContent.includes('2 hands')`, 'other card has two independently dismissible hands');
  await cdp.evaluate(`document.getElementById('reply').value = 'Keep question three draft';
    document.getElementById('reply').dispatchEvent(new Event('input', {bubbles:true}));`);
  await openContextMenu(`.tile[data-id="${otherSessionId}"]`);
  assert.equal(await cdp.evaluate("document.getElementById('menu-dismiss-hand').textContent"), 'Dismiss Hand: Other helper');
  await cdp.evaluate("document.getElementById('menu-dismiss-hand').click()");
  await waitFor(`document.querySelector('.tile[data-id="${otherSessionId}"] .hand-badge')?.textContent === '\u270B Hand raised'`, 'menu dismissal clears only its named target hand');
  assert.equal((await client.call('get_reply', { requestId: otherHand.id, waitSeconds: 0 })).status, 'dismissed');
  assert.equal((await client.call('get_reply', { requestId: retainedHand.id, waitSeconds: 0 })).status, 'pending');
  assert.equal((await client.call('get_reply', { requestId: third.id, waitSeconds: 0 })).status, 'pending');
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected').dataset.id"), sessionId, 'dismissing another card does not change the selected conversation');
  assert.equal(await cdp.evaluate("document.getElementById('reply').value"), 'Keep question three draft');
  await openContextMenu(`.tile[data-id="${otherSessionId}"]`);
  assert.equal(await cdp.evaluate("document.getElementById('menu-dismiss-hand').textContent"), 'Dismiss Hand');
  await cdp.evaluate("document.getElementById('menu-dismiss-hand').click()");
  await waitFor(`!document.querySelector('.tile[data-id="${otherSessionId}"]').classList.contains('hand')`, 'last bridge hand leaves no raised badge');
  assert.equal((await client.call('get_reply', { requestId: retainedHand.id, waitSeconds: 0 })).status, 'dismissed');
  await openContextMenu(`.tile[data-id="${otherSessionId}"]`);
  assert.equal(await cdp.evaluate("document.getElementById('menu-dismiss-hand').hidden"), true, 'no dismissal option without a raised hand');
  await cdp.evaluate("document.getElementById('session-menu').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))");
  await cdp.evaluate("document.getElementById('dismiss').click()");
  await waitFor("document.getElementById('send').textContent.includes('Copy for Copilot')", 'dismissed hand returns to observer mode');
  assert.equal((await client.call('get_reply', { requestId: third.id, waitSeconds: 0 })).status, 'dismissed');
  fixtureState.sessions[0].messages = [
    { id: 'native-context-one', kind: 'context', message: 'First native question', createdAt: new Date().toISOString() },
    { id: 'native-context-two', kind: 'context', message: 'Second native question', createdAt: new Date().toISOString() },
    { id: 'native-update', kind: 'update', message: 'An unread update', createdAt: new Date().toISOString() },
  ];
  await waitFor("document.querySelector('.tile.selected .hand-badge')?.textContent === '\u270B Hand raised'", 'multiple native messages count as one parent hand');
  assert.equal(await cdp.evaluate("document.getElementById('hand-count').textContent"), '1 hand raised');
  const parent = await client.call('raise_hand', { sessionId, message: 'Parent bridge question' });
  await waitFor("document.querySelector('.message.active .message-text')?.textContent === 'Parent bridge question'", 'parent bridge hand arrives alongside native history');
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected .hand-badge').textContent"), '\u270B Hand raised');
  assert.equal(await cdp.evaluate("document.getElementById('hand-count').textContent"), '1 hand raised');
  await cdp.evaluate("document.getElementById('dismiss').click()");
  await waitFor("document.getElementById('hand-count').textContent === 'No hands raised'", 'clearing the one parent hand removes its badge');
  assert.equal((await client.call('get_reply', { requestId: parent.id, waitSeconds: 0 })).status, 'dismissed');
  fixtureState.sessions[0].messages = [{ id: 'native-dismiss', kind: 'context', message: 'A history-only hand to acknowledge locally.' }];
  await waitFor("document.querySelector('.tile.selected').classList.contains('hand')", 'history-only context raises a hand');
  await openContextMenu('.tile.selected');
  assert.equal(await cdp.evaluate("document.getElementById('menu-dismiss-hand').hidden"), false);
  await cdp.evaluate("document.getElementById('menu-dismiss-hand').click()");
  await waitFor("document.getElementById('hand-count').textContent === 'No hands raised'", 'history-only context can be acknowledged without pretending to answer in Copilot');
  await delay(2200);
  assert.equal(await cdp.evaluate("document.querySelector('.tile.selected').classList.contains('hand')"), false, 'local acknowledgement survives polling');
  fixtureState.sessions[0].messages = [];
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.evaluate(`document.getElementById('reply').value = 'Keep this chat draft';
    document.getElementById('reply').dispatchEvent(new Event('input', {bubbles:true}));`);
  const divider = await cdp.evaluate(`(() => {
    const rect = document.getElementById('chat-resizer').getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + 100, width: document.getElementById('conversation').getBoundingClientRect().width};
  })()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x, y: divider.y, buttons: 0 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: divider.x, y: divider.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x - 180, y: divider.y, button: 'left', buttons: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divider.x - 180, y: divider.y, button: 'left', buttons: 0, clickCount: 1 });
  const resizedWidth = await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width");
  assert.ok(Math.abs(resizedWidth - divider.width - 180) <= 1,
    `dragging divider gives the chat the requested extra width: ${divider.width} -> ${resizedWidth}`);
  await cdp.evaluate("document.getElementById('chat-resizer').focus()");
  await pressKey('ArrowLeft', 37);
  assert.ok(Math.abs(await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width") - resizedWidth - 20) <= 1);
  await pressKey('Home', 36);
  assert.equal(await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width"), 295);
  await pressKey('End', 35);
  assert.equal(await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width"), 900);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 982, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.getElementById('conversation').getBoundingClientRect().width <= 490", 'chat clamps to preserve room space in a narrower window');
  assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.getElementById('conversation').getBoundingClientRect().width === 900", 'preferred width returns when the window grows');
  await cdp.evaluate("document.getElementById('chat-resizer').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  assert.equal(await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width"), 340);
  await cdp.evaluate("document.getElementById('chat-resizer').focus()");
  await pressKey('ArrowLeft', 37);
  const savedChatWidth = await cdp.evaluate("localStorage.getItem('critter-chat-width')");
  assert.equal(savedChatWidth, '360');
  const chatTarget = await cdp.evaluate(`(() => {
    const tile = document.querySelector('.tile.selected');
    const rect = tile.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await clickPoint(chatTarget.x, chatTarget.y, 1);
  await clickPoint(chatTarget.x, chatTarget.y, 2);
  assert.equal(await cdp.evaluate("document.getElementById('workspace').classList.contains('chat-expanded')"), true, 'native agent double-click expands chat');
  assert.ok(await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width >= 1000"));
  assert.equal(await cdp.evaluate("document.getElementById('reply').value"), 'Keep this chat draft');
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.meeting')).display"), 'none');
  if (process.env.CRITTER_SCREENSHOT) {
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(process.env.CRITTER_SCREENSHOT.replace(/\.png$/i, '-expanded-chat.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await pressKey('Escape', 27);
  assert.equal(await cdp.evaluate("document.getElementById('workspace').classList.contains('chat-expanded')"), false);
  assert.equal(await cdp.evaluate("document.getElementById('conversation').getBoundingClientRect().width"), 360);
  assert.equal(await cdp.evaluate("document.getElementById('reply').value"), 'Keep this chat draft');
  fixtureState.sessions[1].messages = [{ id: 'double-click-unread', kind: 'update', message: 'Unread update for double-click regression.' }];
  await waitFor(`document.querySelector('.tile[data-id="${fixtureState.sessions[1].id}"]').classList.contains('hand')`, 'unread agent is available for native double-click');
  const unreadTarget = await cdp.evaluate(`(() => {
    window.unreadChatTile = document.querySelector('.tile[data-id="${fixtureState.sessions[1].id}"]');
    const rect = window.unreadChatTile.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await clickPoint(unreadTarget.x, unreadTarget.y, 1);
  assert.ok(await cdp.evaluate("document.querySelector('.tile.selected') === window.unreadChatTile"), 'acknowledging an unread update preserves the click target');
  await clickPoint(unreadTarget.x, unreadTarget.y, 2);
  assert.equal(await cdp.evaluate("document.getElementById('workspace').classList.contains('chat-expanded')"), true);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor("document.getElementById('conversation').getBoundingClientRect().width <= innerWidth", 'expanded chat adapts to mobile');
  assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  assert.equal(await cdp.evaluate("getComputedStyle(document.getElementById('chat-resizer')).display"), 'none');
  await cdp.evaluate("document.getElementById('expand-chat').click()");
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.meeting')).display"), 'flex');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate(`document.querySelector('.tile[data-id="${sessionId}"]').click()`);
  assert.equal(await cdp.evaluate("document.getElementById('reply').value"), 'Keep this chat draft');
  await cdp.evaluate("document.getElementById('reply').value = ''; document.getElementById('reply').dispatchEvent(new Event('input', {bubbles:true}))");
  fixtureState.sessions[1].messages = [];
  await cdp.call('Page.reload');
  await waitFor("document.querySelectorAll('.tile').length === 12 && document.getElementById('conversation').getBoundingClientRect().width === 360", 'custom chat width survives reload');
  await cdp.evaluate("document.getElementById('sound').value = 'off'");
  await cdp.evaluate(`document.querySelector('.tile').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: innerWidth - 5, clientY: innerHeight - 5
  }));`);
  assert.equal(await cdp.evaluate("document.getElementById('session-menu').hidden"), false);
  assert.equal(await cdp.evaluate("document.getElementById('menu-title').textContent"), renamedTitle);
  assert.ok(await cdp.evaluate(`(() => {
    const bounds = document.getElementById('session-menu').getBoundingClientRect();
    return bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  })()`), 'Right-click menu stays inside the viewport');
  await cdp.evaluate("document.querySelector('#session-menu [data-state=\"resolved\"]').click()");
  await waitFor("document.getElementById('resolved-count').textContent === '1' && document.querySelectorAll('.tile').length === 11", 'resolved call leaves the room');
  const trackerPath = join(home, 'critter-call', 'session-status.json');
  assert.equal(JSON.parse(await readFile(trackerPath, 'utf8')).sessions[sessionId].state, 'resolved');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"resolved\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 1 && document.querySelector('.tile').dataset.id === " + JSON.stringify(sessionId), 'resolved call appears in Out to play');
  assert.equal(await cdp.evaluate("document.getElementById('show-playground').hidden"), false);
  assert.equal(await cdp.evaluate("document.getElementById('playground').hidden"), true, 'Playground is opt-in');
  fixtureState.sessions[0].messages = [{ id: 'playground-recap', kind: 'update', message: 'Together we fixed the timer race and added regression coverage.' }];
  await cdp.evaluate("document.getElementById('show-playground').click()");
  await waitFor("!document.getElementById('playground').hidden && document.querySelectorAll('.playground-critter').length === 1", 'resolved critter enters the playground');
  await cdp.evaluate("document.querySelector('.playground-critter').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  assert.equal(await cdp.evaluate("document.getElementById('workspace').classList.contains('chat-expanded')"), true, 'playground critter double-click also expands chat');
  assert.equal(await cdp.evaluate("document.getElementById('playground').dataset.motion"), 'paused', 'hidden playground pauses in expanded chat');
  await cdp.evaluate("document.getElementById('expand-chat').click(); document.querySelector('.playground-critter').blur()");
  assert.equal(await cdp.evaluate("document.getElementById('grid').hidden"), true);
  await waitFor("document.querySelector('.playground-body').complete && document.querySelector('.playground-body').naturalWidth > 0", 'playground uses the existing character artwork');
  assert.equal(await cdp.evaluate("document.querySelector('.playground-critter').dataset.hash"),
    await cdp.evaluate("document.querySelector('.tile .character-scene').dataset.hash"));
  const initialPosition = await cdp.evaluate("document.querySelector('.playground-critter').style.cssText");
  await waitFor("document.querySelector('.playground-critter').classList.contains('walking') && document.querySelector('.playground-critter').style.cssText !== " + JSON.stringify(initialPosition), 'critter wanders along the garden');
  await cdp.evaluate("window.playgroundButton = document.querySelector('.playground-critter')");
  await delay(2200);
  assert.equal(await cdp.evaluate("document.querySelector('.playground-critter') === window.playgroundButton"), true, 'polling preserves roaming sprites');
  await cdp.evaluate("document.querySelector('.playground-critter').dispatchEvent(new PointerEvent('pointerenter'))");
  await waitFor("!document.getElementById('playground-card').hidden && document.getElementById('playground-card').textContent.includes('Together we fixed the timer race')", 'hover card shows the recorded collaboration recap');
  assert.equal(await cdp.evaluate("document.querySelector('.playground-thread').textContent"), renamedTitle);
  const heldPosition = await cdp.evaluate("document.querySelector('.playground-critter').style.translate");
  await delay(300);
  assert.equal(await cdp.evaluate("document.querySelector('.playground-critter').style.translate"), heldPosition, 'inspected critter holds still');
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.evaluate("document.querySelector('.playground-critter').dispatchEvent(new PointerEvent('pointerleave')); document.querySelector('.playground-critter').blur(); document.querySelector('.playground-critter').focus()");
  assert.equal(await cdp.evaluate("document.getElementById('playground-card').hidden"), false, 'keyboard focus shows the same card');
  await cdp.evaluate("document.querySelector('.playground-critter').click()");
  assert.equal(await cdp.evaluate("document.getElementById('conversation-title').textContent"), renamedTitle);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.evaluate("document.querySelector('.playground-critter').blur(); document.querySelector('.playground-critter').focus()");
  assert.ok(await cdp.evaluate(`(() => {
    const card = document.getElementById('playground-card').getBoundingClientRect();
    const stage = document.querySelector('.playground-stage').getBoundingClientRect();
    return card.left >= stage.left && card.right <= stage.right && card.top >= stage.top && card.bottom <= stage.bottom
      && document.documentElement.scrollWidth <= innerWidth;
  })()`), 'playground and hover card stay inside the mobile viewport');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate("document.querySelector('.playground-critter').blur()");
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor("document.getElementById('playground').dataset.motion === 'paused'", 'reduced-motion preference pauses the playground');
  const stillPosition = await cdp.evaluate("document.querySelector('.playground-critter').style.cssText");
  await delay(300);
  assert.equal(await cdp.evaluate("document.getElementById('playground').dataset.motion"), 'paused');
  assert.equal(await cdp.evaluate("document.querySelector('.playground-critter').style.cssText"), stillPosition, 'reduced motion stops roaming, not just CSS animation');
  await cdp.call('Emulation.setEmulatedMedia', { features: [] });
  await cdp.call('Page.reload');
  await waitFor("!document.getElementById('playground').hidden && document.querySelectorAll('.playground-critter').length === 1", 'playground preference survives reload');
  if (process.env.CRITTER_SCREENSHOT) {
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(process.env.CRITTER_SCREENSHOT.replace(/\.png$/i, '-playground.png'), Buffer.from(screenshot.data, 'base64'));
  }
  const encounter = await cdp.evaluate(`(async () => {
    const { Playground } = await import('/playground.mjs');
    const { characterFromText } = await import('/characters.mjs');
    const root = document.createElement('section');
    root.className = 'playground';
    root.innerHTML = '<div class="playground-stage"><canvas width="480" height="300"></canvas><div class="playground-sprites"></div><div class="playground-card" id="encounter-card" hidden></div></div><p class="playground-caption"></p>';
    document.querySelector('.meeting').append(root);
    const widget = new Playground(root, { select() {}, menu() {} });
    const sessions = [{ id: 'friend-a', name: 'Friend A', title: 'A', messages: [] },
      { id: 'friend-b', name: 'Friend B', title: 'B', messages: [] }];
    const art = await characterFromText('friend');
    const assets = new Map(sessions.map(session => [session.id, { hash: art.hash,
      urls: { character: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(art.layers.character) } }]));
    widget.update(sessions, assets);
    const [one, two] = widget.world.agents.values();
    Object.assign(one, { x: 210, y: 162, pause: 1 });
    Object.assign(two, { x: 228, y: 162, pause: 1 });
    widget.world.tick(.01);
    widget.paint();
    const result = [...root.querySelectorAll('.playground-critter')].map(button => ({
      heart: !button.querySelector('.playground-heart').hidden,
      squish: getComputedStyle(button.querySelector('img')).animationName,
    }));
    widget.destroy();
    root.remove();
    return result;
  })()`);
  assert.deepEqual(encounter, [{ heart: true, squish: 'playground-squish' }, { heart: true, squish: 'playground-squish' }]);
  await cdp.evaluate(`(async () => {
    const { Playground, ACTIVITIES } = await import('/playground.mjs');
    const { characterFromText } = await import('/characters.mjs');
    const root = document.createElement('section');
    root.id = 'activity-fixture';
    root.className = 'playground';
    root.innerHTML = '<div class="playground-stage"><canvas width="480" height="300"></canvas><div class="playground-sprites"></div><div class="playground-card" id="activity-card" hidden></div></div><p class="playground-caption"></p>';
    document.querySelector('.meeting').append(root);
    const widget = new Playground(root, { select() {}, menu() {} });
    const sessions = ['boat', 'swing', 'slide', 'bubbles', 'boat-waiter'].map(id => ({
      id, name: id, title: 'Activity check: ' + id, messages: [],
    }));
    const assets = new Map(await Promise.all(sessions.map(async session => {
      const art = await characterFromText(session.id);
      return [session.id, { hash: art.hash, urls: {
        character: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(art.layers.character),
      } }];
    })));
    widget.update(sessions, assets);
    const choices = [0, .3, .6, .9, 0];
    widget.world.random = () => choices.shift() ?? .3;
    for (const [index, agent] of [...widget.world.agents.values()].entries()) {
      Object.assign(agent, index < 4 ? ACTIVITIES[sessions[index].id].entry : { x: 186, y: 186 });
      agent.activityWait = 0;
    }
    const originalTick = widget.world.tick.bind(widget.world);
    const originalPaint = widget.paint.bind(widget);
    const observation = { ticks: 0, using: new Set(), bubbles: false, seated: false, sliding: false, swing: false };
    widget.world.tick = dt => { observation.ticks++; originalTick(dt); };
    widget.paint = () => {
      originalPaint();
      for (const button of root.querySelectorAll('.playground-critter[data-phase="using"]')) {
        observation.using.add(button.dataset.activity);
        if (button.dataset.activity === 'bubbles') {
          const particles = [...button.querySelectorAll('.playground-bubbles i')];
          observation.bubbles = !button.querySelector('.playground-bubbles').hidden && particles.length === 5
            && particles.every(particle => getComputedStyle(particle).animationName === 'playground-bubble');
        }
        if (button.dataset.activity === 'boat') observation.seated =
          Number(root.querySelector('.playground-boat').style.zIndex) < Number(button.style.zIndex)
          && Number(root.querySelector('.playground-boat-rim').style.zIndex) > Number(button.style.zIndex);
        if (button.dataset.activity === 'slide') observation.sliding = new DOMMatrix(getComputedStyle(button.querySelector('img')).transform).b !== 0;
      }
      if (widget.world.swingAngle) observation.swing = root.querySelector('.playground-swing').style.rotate !== '0rad';
    };
    window.activityFixture = { widget, root, observation };
  })()`);
  await delay(250);
  assert.equal(await cdp.evaluate('window.activityFixture.observation.ticks'), 0, 'equipment simulation does not run before enabling Playground');
  assert.equal(await cdp.evaluate("!!document.querySelector('#activity-fixture .playground-boat')"), false, 'equipment drawing is lazy');
  assert.equal(await cdp.evaluate("[...window.activityFixture.widget.world.agents.values()].some(agent => !!agent.activity)"), false);
  await cdp.evaluate('window.activityFixture.widget.setActive(true)');
  await waitFor("window.activityFixture.observation.using.size === 4 && window.activityFixture.observation.swing", 'all four equipment activities run in the real renderer');
  await waitFor('window.activityFixture.observation.bubbles && window.activityFixture.observation.seated && window.activityFixture.observation.sliding',
    'bubble particles, seated boat passenger and slide pose render');
  assert.equal(await cdp.evaluate("window.activityFixture.widget.world.stations.get('boat').queue.length"), 1, 'second sailor waits in line');
  await waitFor("[...document.querySelectorAll('#activity-fixture .playground-boat, #activity-fixture .playground-swing')].every(image => image.complete && image.naturalWidth > 0)", 'original equipment artwork renders');
  if (process.env.CRITTER_SCREENSHOT) {
    const box = await cdp.evaluate(`(() => {
      const rect = document.getElementById('activity-fixture').getBoundingClientRect();
      return {x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height, scale: 1};
    })()`);
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: box });
    await writeFile(process.env.CRITTER_SCREENSHOT.replace(/\.png$/i, '-activities.png'), Buffer.from(screenshot.data, 'base64'));
  }
  const rateStart = await cdp.evaluate('({ticks: activityFixture.observation.ticks, time: performance.now(), nodes: activityFixture.root.querySelectorAll("*").length})');
  await delay(600);
  const rateEnd = await cdp.evaluate('({ticks: activityFixture.observation.ticks, time: performance.now(), nodes: activityFixture.root.querySelectorAll("*").length})');
  assert.equal(rateEnd.nodes, rateStart.nodes, 'active effects reuse a fixed DOM pool');
  assert.ok(rateEnd.ticks - rateStart.ticks <= Math.ceil((rateEnd.time - rateStart.time) * 35 / 1000) + 2,
    'one shared simulation loop stays near its 30 fps budget');
  await cdp.evaluate('window.activityFixture.widget.setActive(false)');
  const pausedActivities = await cdp.evaluate(`JSON.stringify({
    ticks: activityFixture.observation.ticks, boat: activityFixture.widget.world.boat,
    actors: [...activityFixture.widget.world.agents.values()], nodes: activityFixture.root.querySelectorAll('*').length,
  })`);
  await delay(300);
  assert.equal(await cdp.evaluate(`JSON.stringify({
    ticks: activityFixture.observation.ticks, boat: activityFixture.widget.world.boat,
    actors: [...activityFixture.widget.world.agents.values()], nodes: activityFixture.root.querySelectorAll('*').length,
  })`), pausedActivities, 'disabled Playground freezes timers, queues, boat voyages, and bounded effect nodes');
  assert.ok(await cdp.evaluate("[...document.querySelectorAll('#activity-fixture .playground-bubbles i')].every(particle => getComputedStyle(particle).animationPlayState === 'paused')"), 'CSS effects pause too');
  await cdp.evaluate('window.activityFixture.widget.setActive(true)');
  await waitFor('window.activityFixture.observation.ticks > ' + JSON.parse(pausedActivities).ticks, 're-enabling resumes the existing activities');
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor("document.getElementById('activity-fixture').dataset.motion === 'paused'", 'reduced-motion stops equipment');
  const reducedTicks = await cdp.evaluate('activityFixture.observation.ticks');
  await delay(250);
  assert.equal(await cdp.evaluate('activityFixture.observation.ticks'), reducedTicks);
  await cdp.call('Emulation.setEmulatedMedia', { features: [] });
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false });
  const background = await cdp.call('Target.createTarget', { url: 'about:blank' });
  const backgroundTabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const backgroundPage = new DevTools(backgroundTabs.find(tab => tab.id === background.targetId).webSocketDebuggerUrl);
  try {
    await backgroundPage.call('Page.bringToFront');
    await waitFor("document.hidden && document.getElementById('activity-fixture').dataset.motion === 'paused'", 'background tab stops all equipment simulation');
    const hiddenTicks = await cdp.evaluate('activityFixture.observation.ticks');
    await delay(250);
    assert.equal(await cdp.evaluate('activityFixture.observation.ticks'), hiddenTicks);
    await cdp.call('Page.bringToFront');
    await waitFor("!document.hidden && document.getElementById('activity-fixture').dataset.motion === 'running'", 'foreground tab resumes equipment');
  } finally {
    await cdp.call('Target.closeTarget', { targetId: background.targetId });
    backgroundPage.socket.close();
  }
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.evaluate('activityFixture.widget.destroy(); activityFixture.root.remove(); delete window.activityFixture; window.scrollTo(0, 0)');
  await cdp.evaluate(`document.querySelector('.playground-critter').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true
  })); document.getElementById('session-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  assert.equal(await cdp.evaluate("document.activeElement.classList.contains('playground-critter')"), true, 'context-menu Escape restores sprite focus');
  await cdp.evaluate("document.getElementById('show-playground').click()");
  assert.equal(await cdp.evaluate("document.getElementById('playground').dataset.motion"), 'paused');
  assert.equal(await cdp.evaluate("document.getElementById('playground').hidden"), true);
  assert.equal(await cdp.evaluate("document.getElementById('grid').hidden"), false);
  fixtureState.sessions[0].messages = [];
  await cdp.evaluate(`document.querySelector('.tile').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100
  }));`);
  assert.equal(await cdp.evaluate("document.querySelector('#session-menu [data-state=\"in-room\"]').textContent"), 'Pin');
  assert.equal(await cdp.evaluate("document.querySelector('#session-menu [data-state=\"in-room\"]').hidden"), false);
  await cdp.evaluate("document.querySelector('#session-menu [data-state=\"in-room\"]').click()");
  await waitFor("document.getElementById('resolved-count').textContent === '0'", 'Pin restores a call from Out to play');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"in-room\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 12", 'pinned resolved call returns to room');
  await cdp.evaluate(`document.querySelector('.tile[data-id="${sessionId}"]').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100
  })); document.querySelector('#session-menu [data-state="resolved"]').click();`);
  await waitFor("document.getElementById('resolved-count').textContent === '1'", 'pinned call can be resolved again');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"resolved\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 1", 'resolved view repopulates');
  await cdp.call('Page.reload');
  await waitFor("document.querySelector('#session-views [data-view=\"resolved\"]').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.tile').length === 1", 'Out to play and resolved state survive reload');
  await cdp.evaluate("document.getElementById('show-playground').click()");
  await waitFor("!document.getElementById('playground').hidden && document.querySelectorAll('.playground-critter').length === 1", 'restored critter can return to the playground');
  const playgroundHand = await client.call('raise_hand', { sessionId, message: 'Dismiss this playground hand' });
  await waitFor("document.getElementById('source-badge').textContent === 'Reply bridge'", 'playground session receives its hand');
  await openContextMenu('.playground-critter');
  assert.equal(await cdp.evaluate("document.getElementById('menu-dismiss-hand').hidden"), false, 'playground context menu also offers dismissal');
  await cdp.evaluate("document.getElementById('menu-dismiss-hand').click()");
  await waitFor("document.getElementById('source-badge').textContent === 'History only'", 'playground dismissal returns session to history-only');
  assert.equal((await client.call('get_reply', { requestId: playgroundHand.id, waitSeconds: 0 })).status, 'dismissed');
  assert.equal(await cdp.evaluate("document.getElementById('resolved-count').textContent"), '1', 'dismissal does not move a playground session');
  await cdp.evaluate(`document.querySelector('.playground-critter').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100
  })); document.querySelector('#session-menu [data-state="archived"]').click();`);
  await waitFor("document.getElementById('archived-count').textContent === '1' && document.querySelectorAll('.tile').length === 0", 'resolved call moves to Archived');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.playground-critter').length"), 0, 'archiving immediately removes its roaming critter');
  assert.equal(await cdp.evaluate("document.getElementById('playground').dataset.motion"), 'paused', 'empty playground does not animate');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"archived\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 1", 'archived calls remain accessible');
  assert.equal(await cdp.evaluate("document.getElementById('show-playground').hidden && document.getElementById('playground').hidden"), true, 'playground is only available in Out to play');
  await cdp.evaluate(`document.querySelector('.tile').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true
  }));`);
  assert.equal(await cdp.evaluate("document.getElementById('session-menu').hidden"), false);
  await cdp.evaluate(`document.getElementById('session-menu').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true
  }));`);
  assert.equal(await cdp.evaluate("document.activeElement?.classList.contains('tile')"), true);
  await cdp.evaluate(`document.querySelector('.tile').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true
  }));`);
  assert.equal(await cdp.evaluate("document.querySelector('#session-menu [data-state=\"in-room\"]').textContent"), 'Pin');
  await cdp.evaluate('document.querySelector(\'#session-menu [data-state="in-room"]\').click()');
  await waitFor("document.getElementById('archived-count').textContent === '0'", 'archived call restores to the room');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"in-room\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 12", 'restored call rejoins the room');
  assert.equal(JSON.parse(await readFile(trackerPath, 'utf8')).sessions[sessionId].state, 'in-room');
  assert.equal(await cdp.evaluate(`document.querySelector('.tile[data-id="${sessionId}"] .pin-badge').textContent`), 'Pinned', 'Pinned calls are visibly marked');
  fixtureState.sessions = [];
  await waitFor("document.querySelectorAll('.tile').length === 0 && !document.getElementById('empty').hidden", 'room empties after sessions disappear');
  assert.equal(await cdp.evaluate("document.getElementById('conversation-title').textContent"), 'A seat for everyone.');
  assert.equal(await cdp.evaluate("document.getElementById('transcript').children.length"), 0);
  assert.equal(await cdp.evaluate("document.getElementById('reply').disabled"), true);
  await cdp.evaluate("document.getElementById('new-call').click()");
  assert.equal(await cdp.evaluate("document.getElementById('unlock-dialog').open"), true, 'New call requires local control access');
  for (const dismissal of ['close-unlock', 'cancel-unlock', 'escape', 'backdrop']) {
    if (dismissal === 'escape') await pressKey('Escape', 27);
    else if (dismissal === 'backdrop') await clickPoint(5, 5);
    else await cdp.evaluate(`document.getElementById('${dismissal}').click()`);
    await waitFor("!document.getElementById('unlock-dialog').open", 'unlock modal dismisses via ' + dismissal);
    await cdp.evaluate("document.getElementById('new-call').click()");
  }
  await cdp.evaluate(`document.getElementById('control-key').value = ${JSON.stringify(app.controlKey)};
    document.getElementById('unlock-form').requestSubmit();`);
  await waitFor("document.getElementById('new-call-dialog').open", 'control-key unlock continues to New call');
  for (const dismissal of ['close-new-call', 'cancel-new-call', 'escape', 'backdrop']) {
    if (dismissal === 'escape') await pressKey('Escape', 27);
    else if (dismissal === 'backdrop') await clickPoint(5, 5);
    else await cdp.evaluate(`document.getElementById('${dismissal}').click()`);
    await waitFor("!document.getElementById('new-call-dialog').open", 'New Call modal dismisses via ' + dismissal);
    await cdp.evaluate("document.getElementById('new-call').click()");
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 540, deviceScaleFactor: 1, mobile: true });
  assert.ok(await cdp.evaluate(`(() => {
    const box = document.getElementById('close-new-call').getBoundingClientRect();
    const dialog = document.getElementById('new-call-dialog').getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight && dialog.height <= innerHeight - 32
      && document.documentElement.scrollWidth <= innerWidth;
  })()`), 'New Call close button remains reachable on a short mobile viewport');
  await cdp.evaluate("document.getElementById('close-new-call').click()");
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate(`document.getElementById('new-call').click();
    window.createRequests = 0;
    window.originalCreateFetch = window.fetch;
    window.fetch = async (...args) => {
      if (new URL(args[0], location.href).pathname === '/api/calls/new') {
        window.createRequests++;
        const response = await window.originalCreateFetch(...args);
        await new Promise(resolve => { window.finishCreateResponse = resolve; });
        return response;
      }
      return window.originalCreateFetch(...args);
    };`);
  await cdp.evaluate(`document.getElementById('call-folder').value = ${JSON.stringify(home)};
    document.getElementById('call-label').value = 'Browser managed call';
    document.getElementById('call-message').value = 'Request permission';
    document.getElementById('new-call-form').requestSubmit();`);
  await waitFor("!!window.finishCreateResponse && !document.getElementById('new-call-progress').hidden", 'creation is held in flight for dismissal regression');
  assert.equal(await cdp.evaluate("document.getElementById('cancel-new-call').disabled"), false);
  await cdp.evaluate("document.getElementById('cancel-new-call').click()");
  assert.equal(await cdp.evaluate("document.getElementById('new-call-dialog').open"), false, 'pending creation can be dismissed');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"archived\"]').click()");
  assert.equal(await cdp.evaluate("document.querySelector('#session-views [data-view=\"archived\"]').getAttribute('aria-pressed')"), 'true', 'background creation does not lock the rest of the app');
  await cdp.evaluate("document.getElementById('new-call').click()");
  assert.equal(await cdp.evaluate("document.getElementById('create-call').disabled && !document.getElementById('new-call-progress').hidden"), true);
  assert.equal(await cdp.evaluate('window.createRequests'), 1, 'reopening pending creation does not submit it again');
  await pressKey('Escape', 27);
  await cdp.evaluate('window.finishCreateResponse()');
  await waitFor("!document.getElementById('create-call').disabled", 'background creation completes after modal dismissal');
  assert.equal(await cdp.evaluate("document.querySelector('#session-views [data-view=\"archived\"]').getAttribute('aria-pressed')"), 'true', 'background completion does not steal the selected view');
  assert.equal(await cdp.evaluate("document.getElementById('new-call-dialog').open"), false);
  await cdp.evaluate("window.fetch = window.originalCreateFetch; document.querySelector('#session-views [data-view=\"in-room\"]').click()");
  await waitFor("document.getElementById('conversation-title').textContent === 'Browser managed call' && !!document.querySelector('.permission')", 'new real-protocol managed call shows its permission request');
  assert.equal(await cdp.evaluate("document.getElementById('source-badge').textContent"), 'Managed call');
  assert.ok(await cdp.evaluate("document.querySelector('.permission pre').textContent.includes('Write fixture.txt')"));
  assert.ok(await cdp.evaluate("document.getElementById('send').textContent.includes('Queue message')"));
  await cdp.evaluate(`document.getElementById('reply').value = 'Queued browser follow-up';
    document.getElementById('reply').dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('reply-form').requestSubmit();`);
  await waitFor("document.querySelectorAll('.queued-message').length === 1", 'message is durably queued behind permission-blocked active turn');
  await cdp.evaluate("[...document.querySelectorAll('.permission button')].find(button => button.textContent === 'Deny once').click()");
  await waitFor("[...document.querySelectorAll('.message-text')].some(node => node.textContent === 'Fixture response: Queued browser follow-up')", 'denied operation settles and queued follow-up executes');
  await waitFor("document.getElementById('send').textContent.includes('Send message')", 'idle managed session allows unsolicited send');
  await cdp.evaluate(`document.getElementById('reply').value = 'Third browser turn';
    document.getElementById('reply').dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('reply-form').requestSubmit();`);
  await waitFor("[...document.querySelectorAll('.message-text')].some(node => node.textContent === 'Fixture response: Third browser turn')", 'unsolicited third turn requires no bridge hand');
  await cdp.evaluate('window.confirm = () => true');
  await cdp.evaluate("[...document.querySelectorAll('#managed-panel button')].find(button => button.textContent === 'Release to Copilot').click()");
  await waitFor("document.getElementById('send').textContent.includes('Copy for Copilot')", 'release makes managed session history-only');
  await cdp.call('Page.navigate', { url: pathToFileURL(join(home, 'critter-call', 'open-controls.html')).href });
  try {
    await waitFor("location.origin === " + JSON.stringify(origin)
      + " && location.hash === '' && document.getElementById('unlock-controls')?.hidden", 'local launcher unlocks controls and removes the secret URL fragment');
  } catch (error) {
    const page = await cdp.evaluate(`({origin: location.origin, path: location.pathname, hasFragment: !!location.hash,
      title: document.title, warning: document.getElementById('warnings')?.textContent,
      unlockHidden: document.getElementById('unlock-controls')?.hidden})`);
    throw new Error(error.message + ': ' + JSON.stringify(page));
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'New controls and compact header fit on mobile');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: `${origin}/character-lab` });
  await waitFor("!!document.getElementById('seed-hash')?.textContent.match(/[a-f0-9]{64}/)", 'character lab renders a seed');
  await waitFor("document.querySelectorAll('#character-stage img').length === 3 && [...document.querySelectorAll('#character-stage img')].every(image => image.complete && image.naturalWidth)", 'lab shows three valid SVG layers');
  const seed = 'Rapid Fox in the local lab';
  const seedHash = createHash('sha256').update(seed).digest('hex');
  await cdp.evaluate(`document.getElementById('seed-text').value = ${JSON.stringify(seed)};
    document.getElementById('seed-text').dispatchEvent(new Event('input', { bubbles: true }));`);
  await waitFor("document.getElementById('seed-hash').textContent.includes(" + JSON.stringify(seedHash) + ")", 'lab displays exact SHA-256 of textarea text');
  const labVoice = await cdp.evaluate(`(async () => {
    const { voiceFromHash } = await import('/audio.mjs');
    return { profile: voiceFromHash(${JSON.stringify(seedHash)}),
      pitch: document.getElementById('voice-pitch').textContent,
      rate: document.getElementById('voice-rate').textContent };
  })()`);
  assert.ok(labVoice.pitch.includes(labVoice.profile.pitch.toFixed(2)));
  assert.ok(labVoice.rate.includes(labVoice.profile.rate.toFixed(2)));
  const catalog = await (await fetch(`${origin}/api/character/parts`)).json();
  const body = catalog.bodies.at(-1);
  await cdp.evaluate(`document.querySelector('[data-trait="body"]').value = ${JSON.stringify(body)};
    document.querySelector('[data-trait="body"]').dispatchEvent(new Event('change', { bubbles: true }));`);
  await waitFor(`(async () => {
    const { characterFromText } = await import('/characters.mjs');
    const expected = await characterFromText(${JSON.stringify(seed)}, {body: ${JSON.stringify(body)}});
    const layers = [...document.querySelectorAll('#character-stage img')].map(image => {
      const comma = image.src.indexOf(',');
      return image.src.slice(0, comma).includes(';base64')
        ? atob(image.src.slice(comma + 1)) : decodeURIComponent(image.src.slice(comma + 1));
    });
    return Object.values(expected.layers).every(layer => layers.includes(layer));
  })()`, 'lab override renders the exact deterministic layer output');
  await cdp.evaluate(`window.serviceArt = null;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(args[0], location.href).pathname === '/api/character') window.serviceArt = await response.clone().json();
      return response;
    };
    document.getElementById('service-preview').click();`);
  await waitFor("window.serviceArt?.hash === " + JSON.stringify(seedHash), 'lab calls the same-origin generation service');
  assert.equal(await cdp.evaluate('window.serviceArt.traits.body'), body);
  assert.ok(await cdp.evaluate("document.getElementById('lab-error').hidden || !document.getElementById('lab-error').textContent.trim()"), 'Lab does not report rendering errors');
  await cdp.evaluate("document.getElementById('preview-speaking').click()");
  await waitFor("document.getElementById('character-stage').getAnimations({subtree:true}).length > 0", 'lab speech preview animates');
  const motionTargets = await cdp.evaluate("document.getElementById('character-stage').getAnimations({subtree:true}).map(animation => animation.effect.target.className)");
  assert.ok(motionTargets.every(name => /character/i.test(name)), 'Lab motion targets only the character');
  await cdp.evaluate("document.getElementById('preview-speaking').click(); document.querySelector('[data-preview-layer=\"character\"]').click()");
  assert.equal(await cdp.evaluate("document.getElementById('layer-dialog').open"), true);
  await cdp.evaluate("document.getElementById('layer-dialog').close(); document.getElementById('reset-seed').click()");
  await waitFor("document.querySelector('[data-trait=\"body\"]').value !== " + JSON.stringify(body), 'reset clears trait overrides');
  await cdp.evaluate(`window.labAudio = [];
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() { window.labAudio.push(this); return originalPlay.call(this); };
    document.getElementById('voice-mode').value = 'chatter';
    document.getElementById('preview-voice').click();`);
  await waitFor("window.labAudio.length > 0 && document.getElementById('character-stage').getAnimations({subtree:true}).length > 0", 'lab plays actual seeded Animalese with character motion');
  assert.equal(await cdp.evaluate("window.labAudio.at(-1).playbackRate"), labVoice.profile.rate);
  await cdp.evaluate("document.getElementById('stop-voice').click()");
  await waitFor("document.getElementById('character-stage').getAnimations({subtree:true}).length === 0", 'lab Stop ends voice-driven character motion');
  assert.ok(await cdp.evaluate("document.getElementById('voice-error').hidden || !document.getElementById('voice-error').textContent.trim()"), 'Lab voice preview has no audio error');
  const downloadPath = join(home, 'downloads');
  await mkdir(downloadPath);
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await cdp.evaluate("document.querySelector('[data-download-layer=\"character\"]').click()");
  let download;
  for (let index = 0; index < 50; index++) {
    download = (await readdir(downloadPath)).find(name => name.endsWith('.svg'));
    if (download) break;
    await delay(100);
  }
  assert.ok(download, 'Lab produces an actual SVG download');
  const seededArt = await (await fetch(`${origin}/api/character?text=${encodeURIComponent(seed)}`)).json();
  assert.equal(await readFile(join(downloadPath, download), 'utf8'), seededArt.layers.character, 'Downloaded layer exactly matches the seeded SVG');
  if (process.env.CRITTER_SCREENSHOT) {
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(process.env.CRITTER_SCREENSHOT.replace(/\.png$/i, '-lab.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile lab does not overflow horizontally');
  assert.deepEqual(errors, [], 'No unhandled browser exceptions');
  console.log('Browser checks passed: compact header, characters/audio, MCP replies, right-click bridge/history hand dismissal, lifecycle/Pin, chat resize/bounds/persistence and double-click expansion, pixel playground, equipment queues/rides/bubbles and pause lifecycle, dialog X/Cancel/Escape/backdrop dismissal, background New Call, local control unlock, ACP permissions, queued/direct messages, release, mobile layouts, and character lab.');
} finally {
  await client?.close();
  if (cdp && !browserExited) {
    try { await cdp.call('Browser.close'); } catch (error) { if (!browserExited) console.error('Browser close:', error.message); }
    cdp.socket.close();
  }
  if (browser && !browserExited) {
    for (let index = 0; index < 40 && !browserExited; index++) await delay(50);
    if (!browserExited) browser.kill();
  }
  await app?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
