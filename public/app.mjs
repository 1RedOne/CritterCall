import { CritterVoice } from './audio.mjs';
import { characterFromText } from './characters.mjs';
import { Playground } from './playground.mjs';

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
let controlKey = '';
let createOperationId;
let createPayloadKey;
let creatingCall = false;
let afterUnlockNew = false;
const pendingSends = new Map();
let showPlayground = false;
let chatExpanded = false;
let chatWidth;
let chatDrag;
try {
  const storedWidth = localStorage.getItem('critter-chat-width');
  if (storedWidth !== null) {
    chatWidth = Number(storedWidth);
    if (!Number.isFinite(chatWidth) || chatWidth <= 0) throw new Error('Invalid saved chat width.');
  }
} catch { chatWidth = undefined; notify('Chat width could not be restored; using the default layout.'); }
try { showPlayground = localStorage.getItem('critter-show-playground') === 'true'; }
catch { notify('Playground preferences will last only for this visit because browser storage is unavailable.'); }
try {
  controlKey = sessionStorage.getItem('critter-control-key') || '';
} catch { notify('Control access will last only for this page visit because browser storage is unavailable.'); }
const fragmentKey = new URLSearchParams(location.hash.slice(1)).get('control');
if (fragmentKey) {
  controlKey = fragmentKey;
  history.replaceState(null, '', location.pathname + location.search);
  try { sessionStorage.setItem('critter-control-key', controlKey); }
  catch { notify('Controls will stay unlocked only for this page visit.'); }
}
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
const playground = new Playground($('playground'), { select: id => select(id), expand: openAgentChat, menu: openSessionMenu });
const desktopChat = matchMedia('(min-width: 621px)');

function chatBounds() {
  return { min: 295, max: Math.max(295, Math.min(900, $('workspace').clientWidth - 310)) };
}

function applyChatWidth() {
  const { min, max } = chatBounds();
  const defaultWidth = Number.parseFloat(getComputedStyle($('workspace')).getPropertyValue('--chat-default'));
  const width = Math.round(Math.max(min, Math.min(max, chatWidth ?? defaultWidth)));
  $('workspace').style.setProperty('--chat-width', `${width}px`);
  $('chat-resizer').setAttribute('aria-valuemin', min);
  $('chat-resizer').setAttribute('aria-valuemax', max);
  $('chat-resizer').setAttribute('aria-valuenow', width);
  $('chat-resizer').setAttribute('aria-valuetext', `Chat width ${width} pixels`);
}

function saveChatWidth() {
  try {
    if (chatWidth === undefined) localStorage.removeItem('critter-chat-width');
    else localStorage.setItem('critter-chat-width', String(chatWidth));
  } catch { notify('Could not save chat width; it will last only for this visit.'); }
}

function finishChatResize(save = true) {
  if (!chatDrag) return;
  const drag = chatDrag;
  chatDrag = undefined;
  if (!save) chatWidth = drag.preferred;
  document.body.classList.remove('resizing-chat');
  if ($('chat-resizer').hasPointerCapture(drag.pointerId)) $('chat-resizer').releasePointerCapture(drag.pointerId);
  applyChatWidth();
  if (save) saveChatWidth();
}

$('chat-resizer').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !desktopChat.matches || chatExpanded) return;
  event.preventDefault();
  chatDrag = { pointerId: event.pointerId, x: event.clientX,
    width: $('conversation').getBoundingClientRect().width, preferred: chatWidth };
  $('chat-resizer').setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-chat');
});
$('chat-resizer').addEventListener('pointermove', event => {
  if (!chatDrag || event.pointerId !== chatDrag.pointerId) return;
  const { min, max } = chatBounds();
  chatWidth = Math.max(min, Math.min(max, chatDrag.width + chatDrag.x - event.clientX));
  applyChatWidth();
});
$('chat-resizer').addEventListener('pointerup', () => finishChatResize());
$('chat-resizer').addEventListener('pointercancel', () => finishChatResize(false));
$('chat-resizer').addEventListener('lostpointercapture', () => finishChatResize());
$('chat-resizer').addEventListener('dblclick', () => { chatWidth = undefined; applyChatWidth(); saveChatWidth(); });
$('chat-resizer').addEventListener('keydown', event => {
  if (!desktopChat.matches || chatExpanded || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const { min, max } = chatBounds();
  const width = Number($('chat-resizer').getAttribute('aria-valuenow'));
  chatWidth = event.key === 'Home' ? min : event.key === 'End' ? max
    : Math.max(min, Math.min(max, width + (event.key === 'ArrowLeft' ? 20 : -20)));
  applyChatWidth();
  saveChatWidth();
});
window.addEventListener('resize', () => { finishChatResize(); applyChatWidth(); });
applyChatWidth();

function setChatExpanded(expanded) {
  finishChatResize();
  chatExpanded = expanded;
  $('workspace').classList.toggle('chat-expanded', expanded);
  $('expand-chat').textContent = expanded ? 'Back to room' : 'Expand chat';
  $('expand-chat').setAttribute('aria-expanded', String(expanded));
  render();
  if (expanded) $('reply').focus({ preventScroll: true });
  else {
    const container = view === 'resolved' && showPlayground ? $('playground').querySelector('.playground-sprites') : $('grid');
    [...container.children].find(tile => tile.dataset.id === selectedId)?.focus({ preventScroll: true });
  }
}

function openAgentChat(id) {
  if (sending) return;
  select(id);
  if (current()) setChatExpanded(true);
}

$('expand-chat').addEventListener('click', () => setChatExpanded(!chatExpanded));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.defaultPrevented && chatExpanded
    && !document.querySelector('dialog[open]') && $('session-menu').hidden) {
    event.preventDefault();
    setChatExpanded(false);
  }
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
function pending(id) {
  const agents = new Map();
  for (const row of bridgeRequests(id)) {
    if (row.status === 'pending' && !agents.has(row.agentName)) agents.set(row.agentName, row);
  }
  return [...agents.values()];
}
function unread(session) {
  const latest = session.messages.filter(row => !row.user && row.kind !== 'context').at(-1);
  return session.messages.filter(row => !row.user && !seen.has(row.id) && (row.kind === 'context' || row === latest));
}
function hands(session) {
  const agents = new Set(pending(session.id).map(row => row.agentName));
  if (unread(session).length) agents.add(null);
  if (session.managed?.permissions.length) agents.add(null);
  return agents.size;
}
function activeRequest() { return pending(selectedId).find(row => row.id === activeRequestId); }
function draftKey() { return `${selectedId}:${activeRequestId || 'history'}`; }
function saveDraft() { if (selectedId) drafts.set(draftKey(), $('reply').value); }
function playbackMessage() {
  return activeRequest() || (current()?.messages || []).filter(row => !row.user).at(-1) || bridgeRequests(selectedId).at(-1);
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
    const messages = unread(session);
    const message = messages.find(row => row.kind === 'context') || messages.at(-1);
    if (message && !bridge.some(row => row.agentName === null)) {
      hands.push({ key: `history:${message.id}`, sessionId: session.id, name: session.name,
        inRoom: (session.lifecycle || 'in-room') === 'in-room' });
    }
    if (session.managed?.permissions.length && !message && !bridge.some(row => row.agentName === null)) {
      hands.push({ key: `permission:${session.managed.permissions[0].id}`, sessionId: session.id, name: session.name,
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
      session.lifecycle, session.pinned, session.managed?.state, count, pending(session.id).length, view]);
    const previous = existing.get(session.id);
    if (previous?.dataset.renderKey === key) {
      previous.classList.toggle('selected', session.id === selectedId);
      previous.classList.toggle('speaking', speaking && session.id === audioSessionId);
      previous.setAttribute('aria-pressed', String(session.id === selectedId));
      return previous;
    }
    const tile = previous || el('button');
    tile.className = `tile color-${session.color}`;
    tile.type = 'button';
    tile.dataset.id = session.id;
    tile.dataset.renderKey = key;
    tile.classList.toggle('selected', session.id === selectedId);
    tile.classList.toggle('speaking', speaking && session.id === audioSessionId);
    tile.classList.toggle('hand', count > 0);
    tile.setAttribute('aria-pressed', String(session.id === selectedId));
    tile.setAttribute('aria-haspopup', 'menu');
    tile.setAttribute('aria-label', `${session.title}, ${session.name}${session.pinned ? ', pinned' : ''}${count ? `, ${count} raised ${count === 1 ? 'hand' : 'hands'}` : ''}`);
    tile.title = session.title;
    const top = el('span', 'tile-top');
    top.append(el('span', 'tile-status', view === 'archived' ? 'Archived' : view === 'resolved' ? 'Out to play'
      : session.managed && !session.managed.released ? `Managed \u00b7 ${session.managed.state}`
        : session.error ? 'Session error' : pending(session.id).length ? 'Has something to share'
      : session.status === 'needs-context' ? 'Needs context in Copilot' : session.status === 'working' ? 'Working away' : 'Taking a breather'));
    if (count) top.append(el('span', 'hand-badge', `\u270B ${count > 1 ? count + ' hands' : 'Hand raised'}`));
    const scene = characterScene(session);
    const bottom = el('span', 'tile-bottom');
    const name = el('span', 'tile-name');
    name.append(el('span', 'session-name', session.title));
    const wave = el('span', 'wave');
    wave.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 4; index++) wave.append(el('i'));
    name.append(wave);
    const identity = el('span', 'tile-title');
    identity.append(el('span', 'critter-badge', session.name));
    if (session.pinned) identity.append(el('span', 'pin-badge', 'Pinned'));
    bottom.append(name, identity);
    tile.replaceChildren(scene, top, bottom);
    if (!previous) {
      tile.addEventListener('click', () => select(session.id, true));
      tile.addEventListener('dblclick', () => openAgentChat(session.id));
      tile.addEventListener('contextmenu', event => {
        event.preventDefault();
        const latest = visibleSessions().find(row => row.id === session.id);
        if (latest) openSessionMenu(latest, event.clientX, event.clientY);
      });
      tile.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const latest = visibleSessions().find(row => row.id === session.id);
          const bounds = tile.getBoundingClientRect();
          if (latest) openSessionMenu(latest, bounds.left + 20, bounds.top + 30);
        }
      });
    }
    return tile;
  });
  if (tiles.length !== $('grid').children.length || tiles.some((tile, index) => tile !== $('grid').children[index])) {
    $('grid').replaceChildren(...tiles);
  }
  if (focused) [...$('grid').children].find(tile => tile.dataset.id === focused)?.focus({ preventScroll: true });
  const playing = view === 'resolved' && showPlayground;
  $('show-playground').hidden = view !== 'resolved';
  $('show-playground').setAttribute('aria-pressed', String(showPlayground));
  $('grid').hidden = playing;
  $('playground').hidden = !playing;
  playground.setActive(playing && !chatExpanded);
  if (playing) playground.update(visible, characterAssets, selectedId);
  $('empty').hidden = visible.length > 0 || playing;
  for (const [state, countId] of [['in-room', 'tile-count'], ['resolved', 'resolved-count'], ['archived', 'archived-count']]) {
    $(countId).textContent = snapshot.sessions.filter(session => (session.lifecycle || 'in-room') === state).length;
  }
  const roomCount = snapshot.sessions.filter(session => (session.lifecycle || 'in-room') === 'in-room').length;
  $('session-count').textContent = roomCount > 12 ? `${roomCount} in the room` : `${roomCount} / 12 in the room`;
  $('grid').setAttribute('aria-label', view === 'resolved' ? 'Resolved sessions out to play' : view === 'archived' ? 'Archived sessions' : 'Copilot sessions');
  $('empty-title').textContent = view === 'resolved' ? 'No one out to play yet.' : view === 'archived' ? 'Nothing archived yet.' : 'A little quiet in here.';
  $('empty-description').textContent = view === 'resolved' ? 'Right-click a call and choose Move to Resolved when it has all the context it needs.'
    : view === 'archived' ? 'Threads inactive for a week appear here. Right-click and Pin a call to bring it back.'
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
  $('expand-chat').disabled = !session && !chatExpanded;
  $('reply').disabled = !session || sending;
  $('send').disabled = !session || sending || !$('reply').value.trim();
  const managed = session?.managed && !session.managed.released;
  $('send').textContent = sending ? 'Sending...' : request ? 'Send reply \u2197'
    : managed ? session.managed.state === 'idle' ? 'Send message \u2197' : 'Queue message \u2197' : 'Copy for Copilot \u2197';
  $('dismiss').disabled = sending || (!request && (!session || !unread(session).length));
  $('dismiss').textContent = request?.kind === 'update' ? 'Acknowledge update' : 'Dismiss hand';
  $('replay').disabled = !playbackText();
  $('demo-hand').hidden = snapshot.mode !== 'demo';
  renderManaged(session);
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
  $('conversation-title').textContent = session.title;
  $('selected-title').textContent = session.name;
  $('selected-title').title = `${session.title}\n${session.repository || ''}\n${session.id}`;
  $('source-badge').textContent = request ? (snapshot.mode === 'demo' ? 'Demo bridge' : 'Reply bridge') : managed ? 'Managed call' : 'History only';
  $('reply-label').textContent = `To ${request?.agentName || session.name}`;
  $('reply-status').textContent = request
    ? snapshot.mode === 'demo' ? 'Demo reply only. No real agent receives this message.'
      : `Replies return through MCP to this hand${request.agentName ? ` (${request.agentName})` : ''}.`
    : managed ? 'Messages go to this managed call. Busy or disconnected calls keep messages in their queue.'
      : 'Observing local history. Copy your response into this session in Copilot, or connect the MCP bridge.';
  $('composer-hint').textContent = request ? 'Only this hand receives your reply' : managed ? 'One active turn per call' : `Session ${session.id.slice(0, 8)}`;
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
    ...session.messages.map(item => ({ ...item, speaker: item.user ? 'You' : session.name,
      source: session.managed && !session.managed.released ? 'managed' : 'copilot' })),
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
      empty.append(el('span', '', '\u2727'), el('div', '', session.lifecycle === 'archived'
        ? 'Right-click this call and choose Pin to load its history and bring it into the room.'
        : 'Nothing to share just yet.\nGood work sometimes sounds like quiet.'));
      $('transcript').replaceChildren(empty);
    } else {
      $('transcript').replaceChildren(...messages.map(message => {
        const bubble = el('article', `message${message.user ? ' user' : ''}${message.id === activeRequestId ? ' active' : ''}`);
        const label = el('div', 'message-label');
        if (message.delivery) bubble.dataset.delivery = message.delivery;
        label.append(el('span', '', message.speaker), el('span', '', message.delivery || (message.user ? 'reply' : message.kind)));
        const paragraph = el('p', 'message-text', message.message);
        paragraph.dataset.messageId = message.id;
        bubble.append(label, paragraph);
        if (!message.user) bubble.append(el('div', 'message-note',
          message.source === 'managed' ? 'From managed Copilot session'
            : message.source === 'copilot' ? 'From Copilot history \u00b7 read-only'
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
    let response = await fetch(`/api/snapshot${demo ? '?room=demo' : ''}`, { headers: controlKey ? { Authorization: `Bearer ${controlKey}` } : {} });
    if (response.status === 401 && controlKey) {
      controlKey = '';
      try { sessionStorage.removeItem('critter-control-key'); } catch { /* In-memory access is already cleared. */ }
      notify('Local controls are locked. Use the current control key after a server restart.');
      response = await fetch(`/api/snapshot${demo ? '?room=demo' : ''}`);
    }
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
    $('unlock-controls').hidden = demo || next.controls;
    $('new-call').hidden = demo;
    $('control-key-path').textContent = next.controlKeyFile || '';
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
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Call-Token': snapshot.token,
      ...(controlKey ? { Authorization: `Bearer ${controlKey}` } : {}) },
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
  if (restoreFocus) {
    const container = view === 'resolved' && showPlayground ? $('playground').querySelector('.playground-sprites') : $('grid');
    [...container.children].find(tile => tile.dataset.id === id)?.focus();
  }
}

function openSessionMenu(session, x, y) {
  if (sending) return;
  menuSessionId = session.id;
  const menu = $('session-menu');
  $('menu-title').textContent = session.title;
  for (const button of menu.querySelectorAll('button[data-state]')) {
    button.hidden = button.dataset.state === (session.lifecycle || 'in-room')
      || (button.dataset.state === 'archived' && (session.lifecycle || 'in-room') === 'in-room');
  }
  const request = (session.id === selectedId ? activeRequest() : undefined) || pending(session.id)[0];
  const dismiss = $('menu-dismiss-hand');
  dismiss.hidden = !request && !unread(session).length;
  dismiss.dataset.handId = request?.id || '';
  dismiss.textContent = request && hands(session) > 1
    ? `Dismiss Hand: ${request.agentName || session.name}` : 'Dismiss Hand';
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
$('show-playground').addEventListener('click', () => {
  closeSessionMenu();
  showPlayground = !showPlayground;
  try { localStorage.setItem('critter-show-playground', String(showPlayground)); }
  catch { notify('Could not save the playground preference; it will last only for this visit.'); }
  render();
});
for (const button of $('session-menu').querySelectorAll('button[data-state]')) {
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
          : 'Pinned \u00b7 this critter stays in the room until you resolve or archive it.');
    } catch (error) { notify(error.message); }
    finally { sending = false; render(); }
  });
}
$('menu-dismiss-hand').addEventListener('click', () => {
  const session = snapshot.sessions.find(row => row.id === menuSessionId);
  const requestId = $('menu-dismiss-hand').dataset.handId;
  const request = pending(menuSessionId).find(row => row.id === requestId);
  if (requestId && !request) {
    closeSessionMenu(true);
    notify('That hand is no longer pending.');
    return;
  }
  void dismissHand(session, request);
});
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
  if (!request && current().managed && !current().managed.released) {
    const sessionId = selectedId;
    let operation = pendingSends.get(key);
    if (!operation || operation.message !== message) {
      operation = { messageId: crypto.randomUUID(), message };
      pendingSends.set(key, operation);
    }
    sending = true;
    render();
    try {
      await post('/api/calls/message', { sessionId, ...operation });
      pendingSends.delete(key);
      drafts.delete(key);
      $('reply').value = '';
      await refresh();
    } catch (error) { notify(error.message); }
    finally { sending = false; render(); }
    return;
  }
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
async function dismissHand(session, request) {
  if (!session || sending) return;
  const messages = request?.agentName ? [] : unread(session);
  if (!request && !messages.length) return;
  closeSessionMenu(true);
  voice.stop();
  sending = true;
  render();
  try {
    if (request) await post('/api/dismiss', { requestId: request.id });
    for (const message of messages) remember(message.id);
    await refresh();
  } catch (error) { notify(error.message); }
  finally { sending = false; render(); }
}
$('dismiss').addEventListener('click', () => void dismissHand(current(), activeRequest()));
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
window.addEventListener('pagehide', () => { voice.stop(); playground.setActive(false); });
window.addEventListener('pageshow', () => { if (snapshot.sessions.length) render(); });
async function poll() { await refresh(); setTimeout(poll, 2000); }
void poll();

async function managedAction(path, body) {
  if (sending) return;
  sending = true;
  render();
  try { await post(path, body); await refresh(); }
  catch (error) { notify(error.message); }
  finally { sending = false; render(); }
}

function renderManaged(session) {
  const panel = $('managed-panel');
  const focused = document.activeElement?.dataset.control;
  panel.replaceChildren();
  const managed = session?.managed;
  panel.hidden = !managed;
  if (!managed) return;
  const action = (parent, label, path, body, key) => {
    const button = el('button', 'button secondary', label);
    button.type = 'button';
    button.disabled = sending;
    button.dataset.control = key;
    button.addEventListener('click', () => void managedAction(path, { sessionId: session.id, ...body }));
    parent.append(button);
  };
  panel.append(el('p', '', managed.released ? `Released to Copilot. Reopen session ${session.id} there.`
    : `Managed call: ${managed.state}. ${managed.queue.length} queued message(s).`));
  if (managed.error) panel.append(el('p', 'form-error', managed.error));
  if (managed.uncertain) panel.append(el('p', 'form-error', 'Delivery is uncertain. No message will be automatically replayed. Cancel queued messages, release the call, and review its history in Copilot.'));
  for (const permission of managed.permissions) {
    const box = el('section', 'permission');
    box.append(el('strong', '', 'Copilot requests permission for this operation'));
    box.append(el('pre', '', JSON.stringify(permission.toolCall, null, 2)));
    for (const option of permission.options) {
      action(box, option.name, '/api/calls/permission',
        { permissionId: permission.id, optionId: option.optionId }, `${permission.id}:${option.optionId}`);
    }
    action(box, 'Cancel operation', '/api/calls/permission', { permissionId: permission.id, optionId: null }, permission.id);
    panel.append(box);
  }
  for (const message of managed.queue) {
    const row = el('div', 'queued-message');
    row.append(el('p', '', message.message.slice(0, 200)));
    action(row, 'Cancel queued message', '/api/calls/cancel-message', { messageId: message.id }, message.id);
    panel.append(row);
  }
  if (!managed.released && !managed.connected && !managed.uncertain) {
    const reconnect = el('button', 'button secondary', 'Reconnect');
    reconnect.disabled = sending;
    reconnect.addEventListener('click', () => {
      if (confirm('Reconnect only if this session is not open or running in Copilot elsewhere. Continue?')) {
        void managedAction('/api/calls/reconnect', { sessionId: session.id });
      }
    });
    panel.append(reconnect);
  }
  if (!managed.released && !['working', 'awaiting-permission', 'starting'].includes(managed.state) && !managed.queue.length) {
    const release = el('button', 'button secondary', 'Release to Copilot');
    release.disabled = sending;
    release.addEventListener('click', () => {
      if (confirm('Close Critter Call’s connection and make this call history-only? You can then reopen it in Copilot.')) {
        void managedAction('/api/calls/release', { sessionId: session.id });
      }
    });
    panel.append(release);
  }
  if (focused) [...panel.querySelectorAll('button')].find(button => button.dataset.control === focused)?.focus({ preventScroll: true });
}

function showNewCall() {
  if (!snapshot.controls) {
    afterUnlockNew = true;
    $('unlock-dialog').showModal();
    return;
  }
  renderCreationState();
  $('new-call-dialog').showModal();
}
$('new-call').addEventListener('click', showNewCall);
$('unlock-controls').addEventListener('click', () => { afterUnlockNew = false; $('unlock-dialog').showModal(); });
for (const [dialogId, buttons] of [['new-call-dialog', ['cancel-new-call', 'close-new-call']],
  ['unlock-dialog', ['cancel-unlock', 'close-unlock']]]) {
  const dialog = $(dialogId);
  const dismissDialog = () => {
    if (dialogId === 'unlock-dialog') afterUnlockNew = false;
    dialog.close();
  };
  for (const button of buttons) $(button).addEventListener('click', dismissDialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismissDialog(); });
  let outside = false;
  const isOutside = event => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom);
  };
  dialog.addEventListener('pointerdown', event => { outside = isOutside(event); });
  dialog.addEventListener('click', event => { if (outside && isOutside(event)) dismissDialog(); outside = false; });
}
$('unlock-dialog').addEventListener('close', () => {
  if (!$('unlock-dialog').open) { afterUnlockNew = false; $('control-key').value = ''; }
});
$('new-call-dialog').addEventListener('close', () => {
  if (creatingCall) notify('Call creation continues in the background. Closing this window does not cancel the request.');
});
$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  controlKey = $('control-key').value.trim();
  $('control-key').value = '';
  const success = await refresh();
  if (success && snapshot.controls) {
    try { sessionStorage.setItem('critter-control-key', controlKey); } catch { notify('Controls unlocked for this page visit only.'); }
    const continueNewCall = afterUnlockNew && $('unlock-dialog').open;
    $('unlock-dialog').close();
    if (continueNewCall) showNewCall();
  } else {
    $('unlock-error').textContent = 'Unlock failed. Use the current local control key.';
    $('unlock-error').hidden = false;
  }
});
function renderCreationState() {
  $('create-call').disabled = creatingCall;
  $('cancel-new-call').textContent = creatingCall ? 'Close' : 'Cancel';
  $('new-call-progress').hidden = !creatingCall;
  for (const field of $('new-call-form').querySelectorAll('input, textarea')) field.disabled = creatingCall;
}

$('new-call-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || creatingCall) return;
  const payload = { cwd: $('call-folder').value, title: $('call-label').value,
    model: $('call-model').value, message: $('call-message').value };
  const payloadKey = JSON.stringify(payload);
  if (!createOperationId || createPayloadKey !== payloadKey) {
    createOperationId = crypto.randomUUID();
    createPayloadKey = payloadKey;
  }
  creatingCall = true;
  $('new-call-error').hidden = true;
  renderCreationState();
  try {
    const created = await post('/api/calls/new', { operationId: createOperationId, ...payload });
    const showCreated = $('new-call-dialog').open;
    creatingCall = false;
    $('new-call-dialog').close();
    $('new-call-form').reset();
    createOperationId = undefined;
    createPayloadKey = undefined;
    await refresh();
    if (showCreated && !sending) {
      switchView('in-room');
      select(created.sessionId);
    } else notify('Call created and pinned in the room. Its creation was not cancelled by closing the dialog.');
  } catch (error) {
    $('new-call-error').textContent = `${error.message} If creation may have reached Copilot, check history before creating another call.`;
    $('new-call-error').hidden = false;
    if (!$('new-call-dialog').open) notify($('new-call-error').textContent);
  } finally {
    creatingCall = false;
    renderCreationState();
    render();
  }
});
