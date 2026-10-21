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

try {
  const executable = process.env.CRITTER_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  await access(executable);
  app = createCallServer({ home, storePath: join(home, 'critter-call', 'bridge.db'),
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
    catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  assert.equal(await cdp.evaluate("document.querySelectorAll('.tile.hand').length"), 3);
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
  assert.ok(await cdp.evaluate(`(() => {
    const bell = window.audioEvents.find(event => event.kind === 'bell' && event.event === 'end');
    const start = window.audioEvents.find(event => event.kind === 'bell' && event.event === 'start');
    const voice = window.audioEvents.find(event => event.kind === 'voice' && event.event === 'start');
    return !!bell && voice.at >= start.at + start.metric.duration * 1000 - 50 && start.rate === 1;
  })()`), 'Bell finishes before the deterministic agent voice begins');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.spoken-excerpt').length"), 0, 'Announcing a name does not highlight unrelated transcript text');
  const announced = await cdp.evaluate(`(async () => {
    const { voiceFromHash } = await import('/audio.mjs');
    const tile = document.querySelector('.tile.selected');
    const name = tile.querySelector('.tile-name').textContent;
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
  assert.equal(await cdp.evaluate("document.querySelector('.tile .character-scene').dataset.hash"), firstArtwork, 'Character identity survives refresh');
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.ok(await cdp.evaluate("[...document.querySelectorAll('.scene-layer')].every(node => getComputedStyle(node).animationName === 'none')"), 'Reduced motion disables character animation');
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
  await cdp.call('Page.navigate', { url: origin });
  await waitFor("document.getElementById('source-badge').textContent === 'Reply bridge'", 'real stdio bridge hand appears');
  assert.equal(await cdp.evaluate("document.querySelector('.message.active .message-text').textContent"), fullMessage);
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
  await cdp.evaluate("document.getElementById('dismiss').click()");
  await waitFor("document.getElementById('send').textContent.includes('Copy for Copilot')", 'dismissed hand returns to observer mode');
  assert.equal((await client.call('get_reply', { requestId: third.id, waitSeconds: 0 })).status, 'dismissed');
  await cdp.evaluate(`document.querySelector('.tile').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: innerWidth - 5, clientY: innerHeight - 5
  }));`);
  assert.equal(await cdp.evaluate("document.getElementById('session-menu').hidden"), false);
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
  await cdp.call('Page.reload');
  await waitFor("document.querySelector('#session-views [data-view=\"resolved\"]').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.tile').length === 1", 'Out to play and resolved state survive reload');
  await cdp.evaluate(`document.querySelector('.tile').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100
  })); document.querySelector('#session-menu [data-state="archived"]').click();`);
  await waitFor("document.getElementById('archived-count').textContent === '1' && document.querySelectorAll('.tile').length === 0", 'resolved call moves to Archived');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"archived\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 1", 'archived calls remain accessible');
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
  })); document.querySelector('#session-menu [data-state="in-room"]').click();`);
  await waitFor("document.getElementById('archived-count').textContent === '0'", 'archived call restores to the room');
  await cdp.evaluate("document.querySelector('#session-views [data-view=\"in-room\"]').click()");
  await waitFor("document.querySelectorAll('.tile').length === 12", 'restored call rejoins the room');
  assert.equal(JSON.parse(await readFile(trackerPath, 'utf8')).sessions[sessionId].state, 'in-room');
  fixtureState.sessions = [];
  await waitFor("document.querySelectorAll('.tile').length === 0 && !document.getElementById('empty').hidden", 'room empties after sessions disappear');
  assert.equal(await cdp.evaluate("document.getElementById('conversation-title').textContent"), 'A seat for everyone.');
  assert.equal(await cdp.evaluate("document.getElementById('transcript').children.length"), 0);
  assert.equal(await cdp.evaluate("document.getElementById('reply').disabled"), true);
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
  console.log('Browser checks passed: layered characters and motion, first-click-only audio, bell then seeded agent name, three-sentence highlights, MCP replies, lifecycle persistence, mobile layouts, and character lab hash/overrides/API/preview.');
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
