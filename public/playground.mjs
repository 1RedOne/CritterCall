export const GARDEN = Object.freeze({ width: 480, height: 300, cell: 12 });
const obstacles = [
  [30, 102, 132, 120], // Pond bank.
  [282, 18, 156, 114], // Cottage and roof.
  [174, 66, 66, 30], // Flower bed.
  [318, 198, 72, 30], // Bench.
  [60, 30, 48, 48], // Swing frame.
  [270, 174, 36, 60], // Slide.
  [36, 246, 48, 18], // Bubble stand.
];
export const ACTIVITIES = Object.freeze({
  boat: { entry: { x: 186, y: 162 }, seat: { x: 126, y: 162 }, exit: { x: 186, y: 138 }, line: { x: 186, y: 270 }, boarding: 2 },
  swing: { entry: { x: 126, y: 54 }, seat: { x: 84, y: 66 }, exit: { x: 150, y: 90 }, line: { x: 30, y: 90 }, boarding: 1.5 },
  slide: { entry: { x: 258, y: 210 }, seat: { x: 282, y: 180 }, exit: { x: 306, y: 246 }, line: { x: 258, y: 114 }, boarding: 2 },
  bubbles: { entry: { x: 102, y: 258 }, seat: { x: 114, y: 258 }, exit: { x: 126, y: 234 }, line: { x: 222, y: 258 }, boarding: .8 },
});

export function walkable(x, y) {
  return x >= 24 && x <= 456 && y >= 24 && y <= 276
    && !obstacles.some(([left, top, width, height]) =>
      x >= left - 6 && x <= left + width + 6 && y >= top - 6 && y <= top + height + 6);
}

const columns = GARDEN.width / GARDEN.cell;
const rows = GARDEN.height / GARDEN.cell;
const point = key => ({ x: (key % columns) * 12 + 6, y: Math.floor(key / columns) * 12 + 6 });
const keyFor = ({ x, y }) => Math.floor(y / 12) * columns + Math.floor(x / 12);
const ground = Array.from({ length: columns * rows }, (_, key) => key)
  .filter(key => { const p = point(key); return walkable(p.x, p.y); });
const groundSet = new Set(ground);

export function gardenPath(start, destination) {
  const first = keyFor(start);
  const last = keyFor(destination);
  if (!groundSet.has(first) || !groundSet.has(last)) return [];
  const previous = new Map([[first, null]]);
  const queue = [first];
  for (let cursor = 0; cursor < queue.length && !previous.has(last); cursor++) {
    const key = queue[cursor];
    const x = key % columns;
    for (const next of [x > 0 ? key - 1 : -1, x < columns - 1 ? key + 1 : -1, key - columns, key + columns]) {
      if (!groundSet.has(next) || previous.has(next)) continue;
      previous.set(next, key);
      queue.push(next);
    }
  }
  if (!previous.has(last)) return [];
  const path = [];
  for (let key = last; key !== null; key = previous.get(key)) path.push(point(key));
  return path.reverse();
}

const queueSpots = new Map(Object.entries(ACTIVITIES).map(([kind, activity]) => {
  const line = gardenPath(activity.entry, activity.line).filter((_, index) => index % 2 === 0);
  const nearby = ground.map(point).sort((a, b) =>
    Math.hypot(a.x - activity.line.x, a.y - activity.line.y) - Math.hypot(b.x - activity.line.x, b.y - activity.line.y));
  for (const p of nearby) if (line.every(other => Math.hypot(other.x - p.x, other.y - p.y) >= 23)) line.push(p);
  const occupied = new Set(line.map(keyFor));
  line.push(...nearby.filter(p => !occupied.has(keyFor(p))));
  return [kind, line];
}));

export function boatVoyage(random = Math.random) {
  const randomMoves = 1 + Math.floor(random() * 30);
  const points = [];
  let from = ACTIVITIES.boat.seat;
  for (let move = 0; move < randomMoves; move++) {
    const angle = random() * Math.PI * 2;
    const distance = 12 + random() * 12;
    let x = Math.max(70, Math.min(126, from.x + Math.cos(angle) * distance));
    const y = Math.max(140, Math.min(184, from.y + Math.sin(angle) * distance));
    if (Math.hypot(x - from.x, y - from.y) < 4) x = from.x > 98 ? from.x - 12 : from.x + 12;
    const next = { x, y };
    points.push(next);
    from = next;
  }
  points.push({ ...ACTIVITIES.boat.seat });
  return { randomMoves, points, leg: 0 };
}

export function playgroundSummary(session) {
  const latest = session.messages.filter(message => !message.user && message.message?.trim()).at(-1);
  const text = latest?.message.trim() || 'No agent update was recorded. Select this critter to explore its conversation.';
  return text.length > 240 ? text.slice(0, 237) + '...' : text;
}

export class PlaygroundWorld {
  constructor(random = Math.random) {
    this.random = random;
    this.agents = new Map();
    this.stations = new Map(Object.keys(ACTIVITIES).map(kind => [kind, { kind, queue: [], rider: null }]));
    this.boat = { ...ACTIVITIES.boat.seat, angle: 0, voyage: null };
    this.swingAngle = 0;
  }

  sync(sessions) {
    const ids = new Set(sessions.map(session => session.id));
    for (const id of this.agents.keys()) if (!ids.has(id)) this.agents.delete(id);
    for (const station of this.stations.values()) {
      station.queue = station.queue.filter(id => ids.has(id));
      if (station.rider && !ids.has(station.rider)) {
        station.rider = null;
        if (station.kind === 'boat') this.resetBoat();
        if (station.kind === 'swing') this.swingAngle = 0;
      }
    }
    for (const session of sessions) {
      if (this.agents.has(session.id)) continue;
      const free = ground.filter(key => {
        const p = point(key);
        return [...this.agents.values()].every(agent => Math.hypot(agent.x - p.x, agent.y - p.y) > 22);
      });
      const choices = free.length ? free : ground;
      const p = point(choices[Math.floor(this.random() * choices.length)]);
      this.agents.set(session.id, { ...p, id: session.id, path: [], pause: this.random() * 2,
        speed: 14 + this.random() * 10, reaction: 0, cooldown: 0, moving: false, held: false, facing: 1,
        activity: null, activityWait: 3 + this.random() * 9 });
    }
  }

  joinActivity(id, kind) {
    const agent = this.agents.get(id);
    const station = this.stations.get(kind);
    if (!agent || !station) throw new RangeError('Choose an existing critter and playground activity.');
    if (agent.activity) return false;
    agent.activity = { kind, phase: 'queue', slot: -1, elapsed: 0 };
    agent.path = [];
    agent.pause = 0;
    agent.reaction = 0;
    station.queue.push(id);
    return true;
  }

  resetBoat() {
    Object.assign(this.boat, ACTIVITIES.boat.seat, { angle: 0, voyage: null });
  }

  move(agent, dt) {
    const target = agent.path[0];
    if (!target) return;
    const dx = target.x - agent.x;
    const dy = target.y - agent.y;
    const distance = Math.hypot(dx, dy);
    if (dx) agent.facing = dx < 0 ? -1 : 1;
    const fraction = distance ? Math.min(1, agent.speed * dt / distance) : 1;
    agent.x += dx * fraction;
    agent.y += dy * fraction;
    agent.moving = distance > 0;
    if (fraction === 1) agent.path.shift();
  }

  tickStation(station, dt) {
    const definition = ACTIVITIES[station.kind];
    if (station.rider) this.tickRide(this.agents.get(station.rider), station, dt);
    for (const [index, id] of station.queue.entries()) {
      const agent = this.agents.get(id);
      if (agent.held) continue;
      const position = index + (station.rider ? 1 : 0);
      const slot = queueSpots.get(station.kind)[position % ground.length];
      if (agent.activity.slot !== position) {
        agent.activity.slot = position;
        agent.path = gardenPath(agent, slot);
      }
      this.move(agent, dt);
    }
    const first = this.agents.get(station.queue[0]);
    if (!station.rider && first && !first.held && !first.path.length
      && Math.hypot(first.x - definition.entry.x, first.y - definition.entry.y) < .01) {
      station.queue.shift();
      station.rider = first.id;
      Object.assign(first.activity, { phase: 'boarding', elapsed: 0, from: { x: first.x, y: first.y } });
      first.moving = false;
    }
  }

  tickRide(agent, station, dt) {
    if (agent.held) return;
    const activity = agent.activity;
    const definition = ACTIVITIES[activity.kind];
    activity.elapsed += dt;
    const place = (from, to, progress) => {
      agent.x = from.x + (to.x - from.x) * progress;
      agent.y = from.y + (to.y - from.y) * progress;
      if (to.x !== from.x) agent.facing = to.x < from.x ? -1 : 1;
    };
    if (activity.phase === 'boarding') {
      const progress = Math.min(1, activity.elapsed / definition.boarding);
      place(activity.from, definition.seat, progress);
      agent.moving = true;
      if (progress === 1) {
        activity.phase = 'using';
        activity.elapsed = 0;
        activity.duration = activity.kind === 'slide' ? 1.4 : 5 + this.random() * 4;
        if (activity.kind === 'boat') this.boat.voyage = boatVoyage(this.random);
      }
      return;
    }
    if (activity.phase === 'using') {
      let done = activity.elapsed >= activity.duration;
      if (activity.kind === 'boat') {
        const voyage = this.boat.voyage;
        const target = voyage.points[voyage.leg];
        const distance = Math.hypot(target.x - agent.x, target.y - agent.y);
        const fraction = distance ? Math.min(1, 22 * dt / distance) : 1;
        if (distance) {
          const heading = Math.atan2(target.y - agent.y, target.x - agent.x);
          const turn = Math.atan2(Math.sin(heading - this.boat.angle), Math.cos(heading - this.boat.angle));
          this.boat.angle += turn * Math.min(1, dt * 6);
        }
        place(agent, target, fraction);
        Object.assign(this.boat, { x: agent.x, y: agent.y });
        if (fraction === 1) voyage.leg++;
        done = voyage.leg === voyage.points.length;
      } else if (activity.kind === 'swing') {
        const envelope = Math.min(1, activity.elapsed, activity.duration - activity.elapsed);
        this.swingAngle = Math.sin(activity.elapsed * 3.5) * .55 * Math.max(0, envelope);
        agent.x = 84 - Math.sin(this.swingAngle) * 36;
        agent.y = 30 + Math.cos(this.swingAngle) * 36;
      } else if (activity.kind === 'slide') {
        place(definition.seat, { x: 306, y: 222 }, Math.min(1, activity.elapsed / activity.duration));
      }
      if (done) {
        if (activity.kind === 'boat') this.boat.voyage = null;
        if (activity.kind === 'swing') this.swingAngle = 0;
        Object.assign(activity, { phase: 'exiting', elapsed: 0, from: { x: agent.x, y: agent.y } });
      }
      return;
    }
    const disembarking = activity.kind === 'boat' ? definition.boarding : 0;
    if (disembarking) this.boat.angle *= Math.max(0, 1 - dt * 8);
    const progress = Math.min(1, activity.elapsed / (disembarking + 1));
    if (disembarking && activity.elapsed < disembarking) {
      place(activity.from, definition.entry, activity.elapsed / disembarking);
    } else {
      place(disembarking ? definition.entry : activity.from, definition.exit,
        Math.min(1, activity.elapsed - disembarking));
    }
    agent.moving = true;
    if (progress === 1) {
      agent.activity = null;
      agent.path = [];
      agent.pause = 2 + this.random() * 3;
      agent.activityWait = 8 + this.random() * 16;
      station.rider = null;
      if (activity.kind === 'boat') this.resetBoat();
    }
  }

  tick(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Playground time must be finite and nonnegative.');
    const dt = Math.min(seconds, .1);
    for (const agent of this.agents.values()) {
      agent.reaction = Math.max(0, agent.reaction - dt);
      agent.cooldown = Math.max(0, agent.cooldown - dt);
      agent.moving = false;
    }
    for (const station of this.stations.values()) this.tickStation(station, dt);
    for (const agent of this.agents.values()) {
      if (agent.activity) continue;
      if (agent.held) continue;
      agent.activityWait = Math.max(0, agent.activityWait - dt);
      if (!agent.activityWait && !agent.reaction) {
        const kinds = Object.keys(ACTIVITIES);
        this.joinActivity(agent.id, kinds[Math.floor(this.random() * kinds.length)]);
        continue;
      }
      agent.pause = Math.max(0, agent.pause - dt);
      if (agent.pause > 0) continue;
      if (!agent.path.length) {
        agent.path = gardenPath(agent, point(ground[Math.floor(this.random() * ground.length)]));
      }
      this.move(agent, dt);
      if (!agent.path.length) agent.pause = 1.5 + this.random() * 4;
    }
    // Only nearby pairs need encounter checks, even with many archived-era calls.
    const buckets = new Map();
    for (const agent of this.agents.values()) {
      if (agent.activity) continue;
      const bx = Math.floor(agent.x / 24);
      const by = Math.floor(agent.y / 24);
      for (let x = bx - 1; x <= bx + 1; x++) for (let y = by - 1; y <= by + 1; y++) {
        for (const other of buckets.get(`${x}:${y}`) || []) {
          if (agent.held || other.held || agent.cooldown || other.cooldown
            || Math.hypot(agent.x - other.x, agent.y - other.y) > 20) continue;
          for (const friend of [agent, other]) {
            friend.reaction = 1.2;
            friend.cooldown = 5;
            friend.pause = 1.6;
            friend.path = [];
            friend.moving = false;
          }
        }
      }
      const key = `${bx}:${by}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(agent);
    }
  }
}

function drawGarden(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The playground needs a browser with 2D canvas support.');
  const rect = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  rect(0, 0, 480, 300, '#659551');
  let seed = 421;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 2400; i++) {
    rect(Math.floor(random() * 240) * 2, Math.floor(random() * 150) * 2, 2, 2,
      ['#71a15a', '#5b8b48', '#82aa60'][i % 3]);
  }
  rect(240, 12, 24, 276, '#cdb483');
  rect(228, 138, 210, 24, '#cdb483');
  rect(168, 246, 96, 24, '#cdb483');
  for (let i = 0; i < 150; i++) {
    const x = Math.floor(random() * 480);
    const y = Math.floor(random() * 300);
    if ((x >= 240 && x < 264) || (y >= 138 && y < 162 && x >= 228 && x < 438)
      || (y >= 246 && y < 270 && x >= 168 && x < 264)) rect(x, y, 3, 2, '#b99e72');
  }
  const pond = (inset, color) => {
    rect(48 + inset, 108 + inset, 96 - inset * 2, 108 - inset * 2, color);
    rect(36 + inset, 120 + inset, 120 - inset * 2, 84 - inset * 2, color);
  };
  pond(0, '#b8a275');
  pond(4, '#ddd1a0');
  pond(8, '#517fa0');
  pond(12, '#589cbd');
  for (const [x, y] of [[60, 144], [106, 130], [92, 190], [120, 168], [64, 176]]) {
    rect(x, y, 13, 2, '#95d2d8');
    rect(x + 3, y + 3, 5, 2, '#78b5ca');
  }
  for (const [x, y] of [[53, 190], [122, 145]]) {
    rect(x, y, 12, 5, '#8bb66d');
    rect(x + 4, y - 3, 5, 5, '#dba6b9');
  }
  const tree = (x, y) => {
    rect(x - 3, y + 8, 9, 14, '#695641');
    rect(x - 15, y - 8, 30, 24, '#315f43');
    rect(x - 20, y - 4, 40, 14, '#3f7748');
    rect(x - 12, y - 17, 24, 25, '#4e8850');
    rect(x - 6, y - 16, 12, 6, '#68a05b');
  };
  for (let x = 8; x < 480; x += 30) { tree(x, 0); tree(x, 292); }
  for (let y = 30; y < 280; y += 34) { tree(0, y); tree(480, y); }
  rect(300, 60, 120, 60, '#e6cf9b');
  rect(300, 110, 120, 10, '#9e795b');
  rect(294, 52, 132, 12, '#684f50');
  for (let row = 0; row < 5; row++) {
    rect(288 + row * 12, 48 - row * 6, 144 - row * 24, 8, row % 2 ? '#aa7061' : '#b9826a');
  }
  rect(393, 22, 10, 21, '#98776b');
  rect(348, 80, 22, 40, '#86674f');
  rect(352, 84, 14, 31, '#a48058');
  rect(361, 101, 2, 3, '#edcc88');
  for (const x of [312, 384]) {
    rect(x, 78, 21, 24, '#886e5b');
    rect(x + 3, 81, 15, 17, '#8ac3ca');
    rect(x + 9, 81, 3, 17, '#e8d8ad');
    rect(x + 3, 88, 15, 3, '#e8d8ad');
    rect(x - 2, 103, 25, 4, '#a77c5c');
  }
  rect(180, 72, 54, 18, '#94734c');
  rect(183, 75, 48, 12, '#594c3b');
  for (let x = 186; x < 232; x += 10) {
    rect(x, 74, 2, 10, '#78a35a');
    rect(x - 2, 72, 6, 4, x % 3 ? '#eebfa0' : '#e9dc95');
  }
  rect(324, 204, 60, 6, '#b88c5b');
  rect(324, 213, 60, 6, '#cca36d');
  rect(329, 219, 5, 8, '#655544');
  rect(374, 219, 5, 8, '#655544');
  for (const [x, y] of [[186, 184], [408, 246], [276, 228], [168, 42], [72, 66], [420, 174]]) {
    rect(x, y, 2, 7, '#3f7848');
    rect(x - 2, y - 2, 6, 4, '#f2dc9a');
    rect(x, y - 4, 2, 8, '#f6eac2');
  }
  for (let x = 282; x <= 444; x += 18) {
    rect(x, 254, 4, 18, '#dac69a');
    rect(x, 258, 18, 3, '#c1a578');
  }
  rect(132, 155, 48, 15, '#866548');
  for (let x = 134; x < 180; x += 6) rect(x, 156, 4, 12, '#c4a071');
  for (const x of [134, 174]) {
    rect(x, 151, 4, 24, '#6d523e');
    rect(x - 1, 150, 6, 3, '#dfbd8b');
  }
  rect(60, 30, 48, 5, '#ae7d55');
  rect(60, 35, 5, 43, '#8b644a');
  rect(103, 35, 5, 43, '#8b644a');
  rect(57, 76, 11, 4, '#654f3e');
  rect(100, 76, 11, 4, '#654f3e');
  rect(270, 183, 4, 40, '#967454');
  rect(280, 175, 4, 48, '#967454');
  for (let y = 188; y < 224; y += 8) rect(273, y, 9, 3, '#d2ac72');
  rect(278, 174, 12, 6, '#f4cb75');
  for (let step = 0; step < 9; step++) {
    rect(284 + step * 2, 180 + step * 5, 9, 7, '#a2c8c4');
    rect(282 + step * 2, 180 + step * 5, 2, 7, '#648e99');
    rect(293 + step * 2, 180 + step * 5, 2, 7, '#ecdfaa');
  }
  rect(298, 222, 16, 4, '#a2c8c4');
  rect(36, 246, 48, 4, '#f0cf9a');
  rect(39, 250, 42, 14, '#9c8062');
  rect(39, 250, 42, 3, '#b79b76');
  rect(39, 230, 3, 16, '#8f7154');
  rect(78, 230, 3, 16, '#8f7154');
  for (let x = 34; x < 84; x += 10) {
    rect(x, 226, 10, 7, x % 20 ? '#a9d8cd' : '#f2dca5');
    rect(x, 233, 10, 3, x % 20 ? '#86b8ae' : '#d1ba8d');
  }
  for (const x of [46, 59, 72]) {
    rect(x, 240, 6, 6, '#9cd5d2');
    rect(x + 1, 238, 4, 2, '#e2f3db');
  }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class Playground {
  constructor(root, { select, expand = select, menu }) {
    this.root = root;
    this.stage = root.querySelector('.playground-stage');
    this.sprites = root.querySelector('.playground-sprites');
    this.card = root.querySelector('.playground-card');
    this.world = new PlaygroundWorld();
    this.nodes = new Map();
    this.effects = new Map();
    this.sessions = new Map();
    this.select = select;
    this.expand = expand;
    this.menu = menu;
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.reschedule = () => this.schedule();
    this.motion.addEventListener('change', this.reschedule);
    document.addEventListener('visibilitychange', this.reschedule);
    this.resize = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      this.width = width;
      this.height = height;
      if (!this.active) return;
      this.paint();
      if (this.inspected) this.showCard(this.inspected);
    });
    this.resize.observe(this.stage);
  }

  destroy() {
    this.setActive(false);
    this.resize.disconnect();
    this.motion.removeEventListener('change', this.reschedule);
    document.removeEventListener('visibilitychange', this.reschedule);
  }

  ensureScene() {
    if (this.drawn) return;
    drawGarden(this.root.querySelector('canvas'));
    this.width = this.stage.clientWidth;
    this.height = this.stage.clientHeight;
    this.boat = node('img', 'playground-boat');
    this.boat.alt = '';
    this.boat.setAttribute('aria-hidden', 'true');
    this.boat.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16" shape-rendering="crispEdges"><path d="M2 5H25L31 9L25 14H5L1 10Z" fill="#72513e"/><path d="M3 4H24L29 8L24 11H5Z" fill="#d3a968"/><path d="M7 5H23L25 7L23 9H8Z" fill="#9d7751"/><path d="M8 5H11V9H8ZM20 5H23V9H20Z" fill="#e3c18b"/><path d="M5 14H25V16H5Z" fill="#397c9470"/></svg>');
    this.boatRim = node('span', 'playground-boat-rim');
    this.boatRim.setAttribute('aria-hidden', 'true');
    this.swing = node('img', 'playground-swing');
    this.swing.alt = '';
    this.swing.setAttribute('aria-hidden', 'true');
    this.swing.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 42" shape-rendering="crispEdges"><path d="M15 0H17V35H15ZM31 0H33V35H31Z" fill="#e2d4a4"/><path d="M12 34H36V38H12Z" fill="#c78c60"/><path d="M12 38H36V40H12Z" fill="#75513f"/></svg>');
    this.stage.append(this.boat, this.boatRim, this.swing);
    this.drawn = true;
  }

  update(sessions, assets, selectedId) {
    this.sessions = new Map(sessions.map(session => [session.id, session]));
    this.world.sync(sessions);
    for (const [id, button] of this.nodes) if (!this.sessions.has(id)) {
      if (this.inspected === id) this.hideCard();
      button.remove();
      this.nodes.delete(id);
      this.effects.delete(id);
    }
    for (const session of sessions) {
      let button = this.nodes.get(session.id);
      if (!button) {
        button = node('button', 'playground-critter');
        button.type = 'button';
        button.dataset.id = session.id;
        button.dataset.hash = assets.get(session.id).hash;
        button.setAttribute('aria-haspopup', 'menu');
        const image = node('img', 'playground-body');
        image.src = assets.get(session.id).urls.character;
        image.alt = '';
        image.draggable = false;
        const heart = node('span', 'playground-heart', '\u2764\uFE0F');
        heart.setAttribute('aria-hidden', 'true');
        const rest = node('span', 'playground-rest', 'z');
        rest.setAttribute('aria-hidden', 'true');
        const bubbles = node('span', 'playground-bubbles');
        bubbles.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 5; index++) {
          const bubble = node('i', '');
          bubble.style.setProperty('--bubble', index);
          bubbles.append(bubble);
        }
        const wand = node('span', 'playground-wand');
        wand.setAttribute('aria-hidden', 'true');
        button.append(image, heart, rest, wand, bubbles);
        this.effects.set(session.id, { heart, bubbles, wand });
        button.addEventListener('pointerenter', () => this.showCard(session.id));
        button.addEventListener('pointerleave', () => {
          if (document.activeElement !== button) this.hideCard();
        });
        button.addEventListener('focus', () => this.showCard(session.id));
        button.addEventListener('blur', () => this.hideCard());
        button.addEventListener('click', () => this.select(session.id));
        button.addEventListener('dblclick', () => this.expand(session.id));
        button.addEventListener('contextmenu', event => {
          event.preventDefault();
          this.menu(this.sessions.get(session.id), event.clientX, event.clientY);
        });
        button.addEventListener('keydown', event => {
          if (event.key === 'Escape') this.hideCard();
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const box = button.getBoundingClientRect();
            this.menu(this.sessions.get(session.id), box.left, box.bottom);
          }
        });
        this.nodes.set(session.id, button);
        this.sprites.append(button);
      }
      button.dataset.label = `${session.name}, ${session.title}. Select to read the conversation.`;
      button.setAttribute('aria-pressed', String(session.id === selectedId));
    }
    this.root.querySelector('.playground-caption').textContent = sessions.length
      ? `${sessions.length} ${sessions.length === 1 ? 'critter taking a break' : 'critters taking a break'}. Hover or focus to catch up; select to read a thread.`
      : 'No critters out to play yet. Move a call to Resolved to send it here.';
    this.paint();
    if (this.inspected) this.showCard(this.inspected);
    this.schedule();
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (active) this.ensureScene();
    if (!active) this.hideCard();
    this.schedule();
  }

  schedule() {
    const running = this.active && !document.hidden && !this.motion.matches && this.nodes.size > 0;
    this.root.dataset.motion = running ? 'running' : 'paused';
    if (!running) {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.frame = undefined;
      this.lastTime = undefined;
    } else if (this.frame === undefined) {
      this.frame = requestAnimationFrame(time => this.animate(time));
    }
  }

  animate(time) {
    this.frame = undefined;
    if (!this.active || document.hidden || this.motion.matches || !this.nodes.size) {
      this.schedule();
      return;
    }
    if (this.lastTime === undefined || time - this.lastTime >= 1000 / 30 - .5) {
      this.world.tick(this.lastTime === undefined ? 0 : (time - this.lastTime) / 1000);
      this.lastTime = time;
      this.paint();
    }
    this.frame = requestAnimationFrame(next => this.animate(next));
  }

  paint() {
    const width = this.width || this.stage.clientWidth;
    const height = this.height || this.stage.clientHeight;
    for (const [id, button] of this.nodes) {
      const agent = this.world.agents.get(id);
      const effects = this.effects.get(id);
      const translate = `${Math.round(agent.x / GARDEN.width * width * 100) / 100}px ${Math.round(agent.y / GARDEN.height * height * 100) / 100}px`;
      if (button.style.translate !== translate) button.style.translate = translate;
      const depth = String(Math.round(agent.y));
      if (button.style.zIndex !== depth) button.style.zIndex = depth;
      const activity = agent.activity;
      const state = `${agent.moving && !agent.held}:${agent.reaction > 0}:${activity?.kind || ''}:${activity?.phase || ''}:${agent.facing}`;
      if (effects.state !== state) {
        effects.state = state;
        button.style.setProperty('--facing', agent.facing);
        button.classList.toggle('walking', agent.moving && !agent.held);
        button.classList.toggle('social', agent.reaction > 0);
        button.classList.toggle('resting', !agent.moving && !agent.reaction && !activity);
        button.dataset.activity = activity?.kind || '';
        button.dataset.phase = activity?.phase || '';
        effects.heart.hidden = agent.reaction <= 0;
        effects.bubbles.hidden = activity?.kind !== 'bubbles' || activity.phase !== 'using';
        effects.wand.hidden = effects.bubbles.hidden;
      }
      const label = button.dataset.label + (activity
        ? ` ${activity.phase === 'queue' ? 'In line for' : 'Enjoying'} the ${activity.kind === 'boat' ? 'boat ride' : activity.kind}.` : '');
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    }
    if (this.drawn) {
      const translate = `${Math.round(this.world.boat.x / GARDEN.width * width * 100) / 100}px ${Math.round(this.world.boat.y / GARDEN.height * height * 100) / 100}px`;
      const rotate = `${this.world.boat.angle}rad`;
      for (const prop of [this.boat, this.boatRim]) if (prop.style.translate !== translate) prop.style.translate = translate;
      if (this.boat.style.rotate !== rotate) this.boat.style.rotate = rotate;
      const backDepth = String(Math.round(this.world.boat.y) - 1);
      const frontDepth = String(Math.round(this.world.boat.y) + 1);
      if (this.boat.style.zIndex !== backDepth) this.boat.style.zIndex = backDepth;
      if (this.boatRim.style.zIndex !== frontDepth) this.boatRim.style.zIndex = frontDepth;
      const swingRotate = `${this.world.swingAngle}rad`;
      if (this.swing.style.rotate !== swingRotate) this.swing.style.rotate = swingRotate;
    }
  }

  showCard(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (this.inspected && this.inspected !== id) this.hideCard();
    this.inspected = id;
    this.world.agents.get(id).held = true;
    const button = this.nodes.get(id);
    button.setAttribute('aria-describedby', this.card.id);
    this.card.replaceChildren(node('strong', '', session.name), node('span', 'playground-thread', session.title),
      node('span', 'playground-repository', session.repository || 'Local Copilot session'),
      node('span', 'playground-summary-label', 'Latest agent update'), node('p', '', playgroundSummary(session)));
    this.card.hidden = false;
    const bounds = this.stage.getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    const left = anchor.left + anchor.width / 2 - bounds.left - this.card.offsetWidth / 2;
    const above = anchor.top - bounds.top - this.card.offsetHeight - 8;
    this.card.style.left = `${Math.max(8, Math.min(left, bounds.width - this.card.offsetWidth - 8))}px`;
    this.card.style.top = `${Math.max(8, Math.min(above >= 8 ? above : anchor.bottom - bounds.top + 8,
      bounds.height - this.card.offsetHeight - 8))}px`;
  }

  hideCard() {
    const agent = this.world.agents.get(this.inspected);
    if (agent) agent.held = false;
    this.nodes.get(this.inspected)?.removeAttribute('aria-describedby');
    this.inspected = undefined;
    this.card.hidden = true;
  }
}
