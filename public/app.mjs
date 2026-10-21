import { CritterVoice } from './audio.mjs';
import { characterFromText } from './characters.mjs';

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).has('demo');
let snapshot = { sessions: [], requests: [] };
let selectedId;
let activeRequestId;
let sending = false;
let transcriptKey = '';
let speaking = false;
let toastTimer;
const views = ['in-room', 'resolved', 'archived'];
const requestedView = new URLSearchParams(location.search).get('view');
let view = views.includes(requestedView) ? requestedView : 'in-room';
let menuSessionId;
let playbackMessageId;
let playbackProgress;
let highlightedParagraph;
let highlightedBounds;
let highlightedWord;
let audioSessionId;
let audioEnabled = false;
let announcing = false;
let knownHands;
const notificationQueue = [];
const openedCards = new Set();
const characterAssets = new Map();
const drafts = new Map();
let seen = new Set();
try { seen = new Set(JSON.parse(localStorage.getItem('critter-call-seen') || '[]')); }
catch { notify('Browser storage is unavailable; read markers will last only for this visit.'); }

const voice = new CritterVoice(value => {
  speaking = value;
  for (const tile of $('grid').children) tile.classList.toggle('speaking', value && tile.dataset.id === audioSessionId);
  $('selected-emoji').classList.toggle('speaking', value && selectedId === audioSessionId);
}, notify, progress => {
  playbackProgress = progress;
  updatePlaybackHighlight();
});

function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}

function remember(id) {
  seen.add(id);
  seen = new Set([...seen].slice(-600));
  try { localStorage.setItem('critter-call-seen', JSON.stringify([...seen])); }
  catch { notify('Could not save read markers in browser storage.'); }
}

function visibleSessions() { return snapshot.sessions.filter(row => (row.lifecycle || 'in-room') === view); }
function current() { return visibleSessions().find(row => row.id === selectedId); }
function bridgeRequests(id) { return snapshot.requests.filter(row => row.sessionId === id); }
function pending(id) { return bridgeRequests(id).filter(row => row.status === 'pending'); }
function unread(session) {
  const latest = session.messages.filter(row => row.kind !== 'context').at(-1);
  return session.messages.filter(row => row.kind === 'context' || (row === latest && !seen.has(row.id)));
}
function hands(session) { return pending(session.id).length + unread(session).length; }
function activeRequest() { return pending(selectedId).find(row => row.id === activeRequestId); }
function draftKey() { return `${selectedId}:${activeRequestId || 'history'}`; }
function saveDraft() { if (selectedId) drafts.set(draftKey(), $('reply').value); }
function playbackMessage() {
  return activeRequest() || [...(current()?.messages || [])].at(-1) || bridgeRequests(selectedId).at(-1);
}
function playbackText() { return playbackMessage()?.message; }

async function playCurrentMessage() {
  const session = current();
  const message = playbackMessage();
  if (!session || !message) { void drainNotifications(); return; }
  audioEnabled = true;
  audioSessionId = session.id;
  playbackMessageId = message.id;
  try { await voice.play(message.message, characterAssets.get(session.id).hash, $('sound').value); }
  finally { void drainNotifications(); }
}

function raisedHands() {
  const hands = [];
  for (const session of snapshot.sessions) {
    const bridge = pending(session.id);
    for (const request of bridge) hands.push({
      key: `bridge:${request.id}`, sessionId: session.id, name: request.agentName || session.name,
      inRoom: (session.lifecycle || 'in-room') === 'in-room',
    });
    for (const message of unread(session)) {
      if (bridge.length && message.kind !== 'context') continue;
      hands.push({ key: `history:${message.id}`, sessionId: session.id, name: session.name,
        inRoom: (session.lifecycle || 'in-room') === 'in-room' });
    }
  }
  return hands;
}

function detectNewHands() {
  const currentHands = raisedHands();
  if (!knownHands) {
    knownHands = new Set(currentHands.map(hand => hand.key));
    return;
  }
  const queuedSessions = new Set(notificationQueue.map(hand => hand.sessionId));
  let added = 0;
  for (const hand of currentHands) {
    if (knownHands.has(hand.key)) continue;
    knownHands.add(hand.key);
    if (!hand.inRoom || queuedSessions.has(hand.sessionId)) continue;
    notificationQueue.push(hand);
    queuedSessions.add(hand.sessionId);
    added++;
  }
  if (added && !audioEnabled) notify('A critter raised a hand. Click a card to enable sound notifications.');
  void drainNotifications();
}

async function drainNotifications() {
  if (announcing || voice.busy || !audioEnabled || document.hidden || $('sound').value === 'off') return;
  announcing = true;
  try {
    while (notificationQueue.length && audioEnabled && !document.hidden && $('sound').value !== 'off') {
      if (voice.busy) break;
      const hand = notificationQueue.shift();
      if (!raisedHands().some(current => current.key === hand.key && current.inRoom)) continue;
      const assets = characterAssets.get(hand.sessionId);
      if (!assets) continue;
      audioSessionId = hand.sessionId;
      playbackMessageId = undefined;
      notify(`${hand.name} raised a hand.`);
      await voice.announce(hand.name, assets.hash, $('sound').value);
    }
  } finally { announcing = false; }
}

function characterScene(session) {
  const assets = characterAssets.get(session.id);
  if (!assets) throw new Error(`Character artwork is unavailable for ${session.name}.`);
  const scene = el('span', 'character-scene');
  scene.dataset.hash = assets.hash;
  scene.setAttribute('aria-hidden', 'true');
  for (const layer of ['background', 'character', 'foreground']) {
    const image = el('img', `scene-layer ${layer}-layer`);
    image.src = assets.urls[layer];
    image.alt = '';
    image.width = assets.width;
    image.height = assets.height;
    image.draggable = false;
    image.dataset.layer = layer;
    scene.append(image);
  }
  return scene;
}

function updatePlaybackHighlight() {
  const paragraph = [...$('transcript').querySelectorAll('.message-text')]
    .find(node => node.dataset.messageId === playbackMessageId);
  const bounds = playbackProgress && `${playbackProgress.excerptStart}:${playbackProgress.excerptEnd}`;
  if (highlightedParagraph && (!playbackProgress || highlightedParagraph !== paragraph || highlightedBounds !== bounds)) {
    highlightedParagraph.textContent = highlightedParagraph.textContent;
    highlightedParagraph = undefined;
    highlightedWord = undefined;
  }
  if (!playbackProgress || !paragraph) return;
  if (highlightedParagraph !== paragraph) {
    const text = paragraph.textContent;
    const excerpt = el('span', 'spoken-excerpt');
    const excerptText = text.slice(playbackProgress.excerptStart, playbackProgress.excerptEnd);
    for (const match of excerptText.matchAll(/\S+|\s+/gu)) {
      if (/^\s+$/.test(match[0])) excerpt.append(match[0]);
      else {
        const token = el('span', 'spoken-token', match[0]);
        token.dataset.start = playbackProgress.excerptStart + match.index;
        excerpt.append(token);
      }
    }
    paragraph.replaceChildren(text.slice(0, playbackProgress.excerptStart), excerpt, text.slice(playbackProgress.excerptEnd));
    highlightedParagraph = paragraph;
    highlightedBounds = bounds;
  }
  const word = [...paragraph.querySelectorAll('.spoken-token')].find(node => Number(node.dataset.start) === playbackProgress.start);
  if (word === highlightedWord) return;
  highlightedWord?.classList.remove('spoken-word');
  highlightedWord = word;
  word?.classList.add('spoken-word');
  if (word) {
    const box = $('transcript').getBoundingClientRect();
    const position = word.getBoundingClientRect();
    if (position.top < box.top) $('transcript').scrollTop += position.top - box.top - 8;
    else if (position.bottom > box.bottom) $('transcript').scrollTop += position.bottom - box.bottom + 8;
  }
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function renderTiles() {
  const focused = document.activeElement?.dataset.id;
  const visible = visibleSessions();
  const existing = new Map([...$('grid').children].map(tile => [tile.dataset.id, tile]));
  const tiles = visible.map(session => {
    const count = hands(session);
    const key = JSON.stringify([session.name, session.title, session.color, session.error, session.status,
      session.lifecycle, count, pending(session.id).length, view]);
    const previous = existing.get(session.id);
    if (previous?.dataset.renderKey === key) {
      previous.classList.toggle('selected', session.id === selectedId);
      previous.classList.toggle('speaking', speaking && session.id === audioSessionId);
      previous.setAttribute('aria-pressed', String(session.id === selectedId));
      return previous;
    }
    const tile = el('button', `tile color-${session.color}`);
    tile.type = 'button';
    tile.dataset.id = session.id;
    tile.dataset.renderKey = key;
    tile.classList.toggle('selected', session.id === selectedId);
    tile.classList.toggle('speaking', speaking && session.id === audioSessionId);
    tile.classList.toggle('hand', count > 0);
    tile.setAttribute('aria-pressed', String(session.id === selectedId));
    tile.setAttribute('aria-haspopup', 'menu');
    tile.setAttribute('aria-label', `${session.name}, ${session.title}${count ? `, ${count} raised hands` : ''}`);
    const top = el('span', 'tile-top');
    top.append(el('span', 'tile-status', view === 'archived' ? 'Archived' : view === 'resolved' ? 'Out to play' : session.error ? 'Session error' : pending(session.id).length ? 'Has something to share'
      : session.status === 'needs-context' ? 'Needs context in Copilot' : session.status === 'working' ? 'Working away' : 'Taking a breather'));
    if (count) top.append(el('span', 'hand-badge', `\u270B ${count > 1 ? count + ' hands' : 'Hand raised'}`));
    const scene = characterScene(session);
    const bottom = el('span', 'tile-bottom');
    const name = el('span', 'tile-name', session.name);
    const wave = el('span', 'wave');
    wave.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 4; index++) wave.append(el('i'));
    name.append(wave);
    bottom.append(name, el('span', 'tile-title', session.title));
    tile.append(scene, top, bottom);
    tile.addEventListener('click', () => select(session.id, true));
    tile.addEventListener('contextmenu', event => {
      event.preventDefault();
      openSessionMenu(session, event.clientX, event.clientY);
    });
    tile.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const bounds = tile.getBoundingClientRect();
        openSessionMenu(session, bounds.left + 20, bounds.top + 30);
      }
    });
    return tile;
  });
  if (tiles.length !== $('grid').children.length || tiles.some((tile, index) => tile !== $('grid').children[index])) {
    $('grid').replaceChildren(...tiles);
  }
  if (focused) [...$('grid').children].find(tile => tile.dataset.id === focused)?.focus({ preventScroll: true });
  $('empty').hidden = visible.length > 0;
  for (const [state, countId] of [['in-room', 'tile-count'], ['resolved', 'resolved-count'], ['archived', 'archived-count']]) {
    $(countId).textContent = snapshot.sessions.filter(session => (session.lifecycle || 'in-room') === state).length;
  }
  const roomCount = snapshot.sessions.filter(session => (session.lifecycle || 'in-room') === 'in-room').length;
  $('session-count').textContent = `${roomCount} / 12 in the room`;
  $('grid').setAttribute('aria-label', view === 'resolved' ? 'Resolved sessions out to play' : view === 'archived' ? 'Archived sessions' : 'Copilot sessions');
  $('empty-title').textContent = view === 'resolved' ? 'No one out to play yet.' : view === 'archived' ? 'Nothing archived yet.' : 'A little quiet in here.';
  $('empty-description').textContent = view === 'resolved' ? 'Right-click a call and choose Move to Resolved when it has all the context it needs.'
    : view === 'archived' ? 'Archive finished calls from Out to play. You can always bring them back.'
      : 'Open a Copilot session to bring a critter into the room, or explore the demo.';
  $('empty-demo').hidden = view !== 'in-room';
  for (const button of $('session-views').children) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  const count = visible.reduce((sum, session) => sum + hands(session), 0);
  $('hand-count').textContent = count ? `${count} ${count === 1 ? 'hand' : 'hands'} raised` : 'No hands raised';
  $('next-hand').disabled = !count || sending;
}

function select(id, play = false, requestId) {
  if (sending) return;
  saveDraft();
  voice.stop();
  selectedId = id;
  activeRequestId = requestId || pending(id)[0]?.id;
  const session = current();
  if (!session) return;
  for (const message of session.messages) if (message.kind !== 'context') remember(message.id);
  $('reply').value = drafts.get(draftKey()) || '';
  transcriptKey = '';
  render();
  if (play) {
    audioEnabled = true;
    if (!openedCards.has(id)) {
      openedCards.add(id);
      void playCurrentMessage();
    } else void drainNotifications();
  }
}

function renderConversation() {
  const session = current();
  const request = activeRequest();
  $('reply').disabled = !session || sending;
  $('send').disabled = !session || sending || !$('reply').value.trim();
  $('send').textContent = sending ? 'Sending...' : request ? 'Send reply \u2197' : 'Copy for Copilot \u2197';
  $('dismiss').disabled = !request || sending;
  $('dismiss').textContent = request?.kind === 'update' ? 'Acknowledge update' : 'Dismiss hand';
  $('replay').disabled = !playbackText();
  $('demo-hand').hidden = snapshot.mode !== 'demo';
  if (!session) {
    $('selected-emoji').className = 'profile-emoji';
    $('selected-emoji').textContent = '\u{1F331}';
    $('conversation-title').textContent = 'A seat for everyone.';
    $('selected-title').textContent = 'Click a raised hand to hear what is on their mind.';
    $('selected-title').title = '';
    $('source-badge').textContent = 'Choose a critter';
    $('reply-status').textContent = 'Select a character to get started.';
    $('reply-label').textContent = 'A little direction goes a long way.';
    $('composer-hint').textContent = 'Replies go to one agent only';
    $('request-picker').hidden = true;
    $('transcript').replaceChildren();
    transcriptKey = '';
    return;
  }
  const profileClass = `profile-character${speaking && audioSessionId === session.id ? ' speaking' : ''}${hands(session) ? ' hand' : ''}`;
  $('selected-emoji').className = profileClass;
  if ($('selected-emoji').dataset.sessionId !== session.id || !$('selected-emoji').querySelector('.character-scene')) {
    $('selected-emoji').dataset.sessionId = session.id;
    $('selected-emoji').replaceChildren(characterScene(session));
  }
  $('conversation-title').textContent = session.name;
  $('selected-title').textContent = session.title;
  $('selected-title').title = `${session.title}\n${session.repository || ''}\n${session.id}`;
  $('source-badge').textContent = request ? (snapshot.mode === 'demo' ? 'Demo bridge' : 'Reply bridge') : 'History only';
  $('reply-label').textContent = `To ${request?.agentName || session.name}`;
  $('reply-status').textContent = request
    ? snapshot.mode === 'demo' ? 'Demo reply only. No real agent receives this message.'
      : `Replies return through MCP to this hand${request.agentName ? ` (${request.agentName})` : ''}.`
    : 'Observing local history. Copy your response into this session in Copilot, or connect the MCP bridge.';
  $('composer-hint').textContent = request ? 'Only this hand receives your reply' : `Session ${session.id.slice(0, 8)}`;
  const waiting = pending(selectedId);
  $('request-picker').hidden = waiting.length < 2;
  const pickerFocus = document.activeElement?.dataset.request;
  $('request-picker').replaceChildren(...waiting.map((item, index) => {
    const button = el('button', '', `${index + 1}. ${item.agentName || item.kind}`);
    button.dataset.request = item.id;
    button.setAttribute('aria-pressed', String(item.id === activeRequestId));
    button.disabled = sending;
    button.addEventListener('click', () => select(selectedId, true, item.id));
    return button;
  }));
  if (pickerFocus) [...$('request-picker').children].find(button => button.dataset.request === pickerFocus)?.focus({ preventScroll: true });
  const messages = [
    ...session.messages.map(item => ({ ...item, speaker: session.name, source: 'copilot' })),
    ...bridgeRequests(selectedId).flatMap(item => [
      { ...item, speaker: item.agentName || session.name, source: 'bridge' },
      ...(item.reply ? [{ id: `${item.id}-reply`, message: item.reply, createdAt: item.repliedAt, speaker: 'You', user: true }] : []),
    ]),
  ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const key = JSON.stringify([selectedId, activeRequestId, messages]);
  if (key !== transcriptKey) {
    transcriptKey = key;
    if (!messages.length) {
      const empty = el('div', 'transcript-empty');
      empty.append(el('span', '', '\u2727'), el('div', '', 'Nothing to share just yet.\nGood work sometimes sounds like quiet.'));
      $('transcript').replaceChildren(empty);
    } else {
      $('transcript').replaceChildren(...messages.map(message => {
        const bubble = el('article', `message${message.user ? ' user' : ''}${message.id === activeRequestId ? ' active' : ''}`);
        const label = el('div', 'message-label');
        label.append(el('span', '', message.speaker), el('span', '', message.user ? 'reply' : message.kind));
        const paragraph = el('p', 'message-text', message.message);
        paragraph.dataset.messageId = message.id;
        bubble.append(label, paragraph);
        if (!message.user) bubble.append(el('div', 'message-note',
          message.source === 'copilot' ? 'From Copilot history \u00b7 read-only'
            : message.status === 'pending' ? 'Hand raised \u00b7 waiting for you'
              : message.status === 'answered' ? 'Reply delivered to the bridge' : 'Dismissed by you'));
        return bubble;
      }));
      const active = $('transcript').querySelector('.active');
      if (active) $('transcript').scrollTop = active.offsetTop - $('transcript').offsetTop;
      else $('transcript').scrollTop = $('transcript').scrollHeight;
    }
    updatePlaybackHighlight();
  }
}

function render() {
  renderTiles();
  renderConversation();
}

async function refresh() {
  try {
    const response = await fetch(`/api/snapshot${demo ? '?room=demo' : ''}`);
    if (!response.ok) throw new Error(`Local session feed returned ${response.status}.`);
    const next = await response.json();
    await Promise.all(next.sessions.map(async session => {
      if (characterAssets.has(session.id)) return;
      const art = await characterFromText(session.id);
      characterAssets.set(session.id, { ...art, urls: Object.fromEntries(
        Object.entries(art.layers).map(([layer, svg]) => [layer, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`]),
      ) });
    }));
    const sessionIds = new Set(next.sessions.map(session => session.id));
    for (const id of characterAssets.keys()) if (!sessionIds.has(id)) characterAssets.delete(id);
    snapshot = next;
    // An agent can complete a different turn while the human drafts a reply.
    if (selectedId && !current()) {
      saveDraft();
      voice.stop();
      selectedId = undefined;
      activeRequestId = undefined;
      $('reply').value = '';
    }
    if (activeRequestId && !activeRequest()) {
      saveDraft();
      activeRequestId = pending(selectedId)[0]?.id;
      $('reply').value = drafts.get(draftKey()) || '';
    }
    if (selectedId && !activeRequestId && pending(selectedId).length) {
      saveDraft();
      activeRequestId = pending(selectedId)[0].id;
      $('reply').value = drafts.get(draftKey()) || '';
    }
    const visible = visibleSessions();
    if (!selectedId && visible.length) {
      const first = visible.find(session => hands(session)) || visible[0];
      selectedId = first.id;
      activeRequestId = pending(selectedId)[0]?.id;
    }
    $('warnings').textContent = next.warnings.join('\n');
    $('warnings').hidden = !next.warnings.length;
    $('connection').textContent = snapshot.mode === 'demo' ? 'Demo \u00b7 no real agents' : 'Local feed \u00b7 synced just now';
    $('connection').classList.remove('error');
    $('bridge-config').textContent = JSON.stringify(next.bridgeConfig, null, 2);
    const outOfRoom = next.requests.filter(item => item.status === 'pending' && !next.sessions.some(session => session.id === item.sessionId));
    if (outOfRoom.length) {
      $('warnings').hidden = false;
      $('warnings').textContent += `${next.warnings.length ? '\n' : ''}${outOfRoom.length} pending bridge hand(s) belong to sessions outside this latest-12 room. Open those sessions in Copilot to bring them into the room.`;
    }
    render();
    detectNewHands();
    return true;
  } catch (error) {
    $('connection').textContent = 'Local feed disconnected';
    $('connection').classList.add('error');
    $('warnings').textContent = `${error.message} Keep the local server running; the page will reconnect.`;
    $('warnings').hidden = false;
    $('send').disabled = true;
    return false;
  }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Call-Token': snapshot.token },
    body: JSON.stringify({ ...body, room: snapshot.mode }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

function closeSessionMenu(restoreFocus = false) {
  const id = menuSessionId;
  menuSessionId = undefined;
  $('session-menu').hidden = true;
  if (restoreFocus) [...$('grid').children].find(tile => tile.dataset.id === id)?.focus();
}

function openSessionMenu(session, x, y) {
  if (sending) return;
  menuSessionId = session.id;
  const menu = $('session-menu');
  $('menu-title').textContent = session.name;
  for (const button of menu.querySelectorAll('button')) {
    button.hidden = button.dataset.state === (session.lifecycle || 'in-room')
      || (button.dataset.state === 'archived' && (session.lifecycle || 'in-room') === 'in-room');
  }
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button:not([hidden])').focus();
}

function switchView(state) {
  if (sending) return;
  saveDraft();
  voice.stop();
  closeSessionMenu();
  view = state;
  const url = new URL(location.href);
  if (state === 'in-room') url.searchParams.delete('view');
  else url.searchParams.set('view', state);
  history.replaceState(null, '', url);
  selectedId = undefined;
  activeRequestId = undefined;
  $('reply').value = '';
  const first = visibleSessions().find(session => hands(session)) || visibleSessions()[0];
  if (first) select(first.id);
  else render();
}

for (const button of $('session-views').children) button.addEventListener('click', () => switchView(button.dataset.view));
for (const button of $('session-menu').querySelectorAll('button')) {
  button.addEventListener('click', async () => {
    const id = menuSessionId;
    if (!id || sending) return;
    closeSessionMenu();
    voice.stop();
    sending = true;
    render();
    try {
      await post('/api/session-state', { sessionId: id, state: button.dataset.state });
      await refresh();
      notify(button.dataset.state === 'resolved' ? 'Moved to Resolved \u00b7 find this critter in Out to play.'
        : button.dataset.state === 'archived' ? 'Call archived. You can bring it back from Archived.'
          : 'This critter is back in the room.');
    } catch (error) { notify(error.message); }
    finally { sending = false; render(); }
  });
}
document.addEventListener('pointerdown', event => {
  if (!$('session-menu').contains(event.target)) closeSessionMenu();
});
$('session-menu').addEventListener('keydown', event => {
  const buttons = [...$('session-menu').querySelectorAll('button:not([hidden])')];
  const index = buttons.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  if (event.key === 'Escape') { event.preventDefault(); closeSessionMenu(true); }
  if (event.key === 'Tab') closeSessionMenu();
});
window.addEventListener('resize', () => closeSessionMenu());
window.addEventListener('scroll', () => closeSessionMenu(), { passive: true });

$('reply').addEventListener('input', () => {
  saveDraft();
  $('send').disabled = sending || !$('reply').value.trim();
});
$('reply-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || !current() || !$('reply').value.trim()) return;
  const message = $('reply').value;
  const request = activeRequest();
  const key = draftKey();
  if (!request) {
    try { await navigator.clipboard.writeText(message); notify('Copied. Paste into the selected session in Copilot; nothing was sent automatically.'); }
    catch (error) { notify(`Clipboard unavailable. Select and copy your text manually. ${error.message}`); }
    return;
  }
  sending = true;
  render();
  try {
    await post('/api/reply', { requestId: request.id, message });
    drafts.delete(key);
    $('reply').value = '';
    activeRequestId = undefined;
    notify(snapshot.mode === 'demo' ? 'Demo reply delivered. One happy critter!' : 'Reply saved for this agent to collect through MCP.');
    await refresh();
  } catch (error) { notify(error.message); }
  finally { sending = false; render(); }
});
$('dismiss').addEventListener('click', async () => {
  const request = activeRequest();
  if (!request || sending) return;
  sending = true;
  render();
  try {
    await post('/api/dismiss', { requestId: request.id });
    activeRequestId = undefined;
    await refresh();
  } catch (error) { notify(error.message); }
  finally { sending = false; render(); }
});
$('next-hand').addEventListener('click', () => {
  const waiting = visibleSessions().filter(session => hands(session));
  if (!waiting.length) return;
  const index = waiting.findIndex(session => session.id === selectedId);
  select(waiting[(index + 1) % waiting.length].id, true);
});
$('replay').addEventListener('click', playCurrentMessage);
$('stop-audio').addEventListener('click', () => {
  notificationQueue.length = 0;
  voice.stop();
});
$('sound').addEventListener('change', () => {
  voice.stop();
  audioEnabled = $('sound').value !== 'off';
  void drainNotifications();
});
$('demo-hand').addEventListener('click', async () => {
  if (!current()) return;
  try {
    const request = await post('/api/demo/raise', { sessionId: selectedId });
    select(selectedId, false, request.id);
    await refresh();
  } catch (error) { notify(error.message); }
});
$('connect').addEventListener('click', () => $('setup').showModal());
$('close-setup').addEventListener('click', () => $('setup').close());
for (const [button, content] of [['copy-config', 'bridge-config'], ['copy-instruction', 'agent-instruction']]) {
  $(button).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($(content).textContent); notify('Copied to clipboard.'); }
    catch { notify('Clipboard unavailable. Select and copy the text manually.'); }
  });
}
$(demo ? 'demo-room' : 'live-room').setAttribute('aria-current', 'page');
document.addEventListener('visibilitychange', () => {
  if (document.hidden) voice.stop();
  else void drainNotifications();
});
window.addEventListener('pagehide', () => voice.stop());
async function poll() { await refresh(); setTimeout(poll, 2000); }
void poll();
