import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GARDEN, ACTIVITIES, boatVoyage, gardenPath, walkable, PlaygroundWorld, playgroundSummary } from '../public/playground.mjs';

function seededRandom() {
  let seed = 317;
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

test('garden routes stay on connected walkable ground and route around the pond and cottage', () => {
  const path = gardenPath({ x: 18 + 12, y: 90 }, { x: 186, y: 234 });
  assert.ok(path.length > 20, 'pond requires a detour');
  for (const [index, p] of path.entries()) {
    assert.ok(walkable(p.x, p.y));
    if (index) assert.equal(Math.abs(p.x - path[index - 1].x) + Math.abs(p.y - path[index - 1].y), GARDEN.cell);
  }
  assert.deepEqual(gardenPath({ x: 60, y: 150 }, { x: 240, y: 240 }), [], 'no route starts inside water');
  assert.deepEqual(gardenPath({ x: 240, y: 240 }, { x: 336, y: 84 }), [], 'no route ends inside cottage');
  assert.equal(walkable(-1, 100), false);
  assert.equal(walkable(200, 400), false);
});

test('wandering stays inside the garden, includes walks and rests, and resumes after pauses', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync(Array.from({ length: 12 }, (_, index) => ({ id: `critter-${index}` })));
  for (const agent of world.agents.values()) agent.activityWait = Infinity;
  const positions = new Map([...world.agents].map(([id, agent]) => [id, [agent.x, agent.y]]));
  let walking = 0;
  let resting = 0;
  let reactions = 0;
  for (let frame = 0; frame < 2400; frame++) {
    world.tick(.05);
    for (const agent of world.agents.values()) {
      assert.ok(walkable(agent.x, agent.y), `agent ${agent.id} left walkable ground at ${agent.x},${agent.y}`);
      if (agent.moving) walking++;
      if (agent.pause > 0) resting++;
      if (agent.reaction > 0) reactions++;
    }
  }
  assert.ok(walking > 100 && resting > 100 && reactions > 0);
  assert.ok([...world.agents].every(([id, agent]) => Math.hypot(agent.x - positions.get(id)[0], agent.y - positions.get(id)[1]) > 1));
});

test('encounters squish both critters, pause their paths, and expire instead of repeating every frame', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync([{ id: 'one' }, { id: 'two' }]);
  const [one, two] = world.agents.values();
  Object.assign(one, { x: 210, y: 162 });
  Object.assign(two, { x: 228, y: 162 });
  world.tick(0);
  for (const agent of [one, two]) {
    assert.equal(agent.reaction, 1.2);
    assert.equal(agent.cooldown, 5);
    assert.equal(agent.moving, false);
    assert.deepEqual(agent.path, []);
  }
  for (let frame = 0; frame < 13; frame++) world.tick(.1);
  assert.equal(one.reaction, 0);
  assert.equal(two.reaction, 0);
  assert.ok(one.pause > 0 && two.pause > 0);
  assert.ok(one.cooldown < 4, 'nearby friends do not restart the reaction every frame');
});

test('session refresh preserves positions and routes; removing or pinning a call removes its critter', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync([{ id: 'one' }, { id: 'two' }]);
  const one = world.agents.get('one');
  one.path = [{ x: 246, y: 246 }];
  world.sync([{ id: 'one', title: 'Renamed thread' }, { id: 'three' }]);
  assert.equal(world.agents.get('one'), one);
  assert.deepEqual(one.path, [{ x: 246, y: 246 }]);
  assert.equal(world.agents.has('two'), false);
  assert.equal(world.agents.has('three'), true);
  world.sync([]);
  assert.equal(world.agents.size, 0);
});

test('inspection holds the critter still and elapsed time cannot cause a giant background-tab jump', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync([{ id: 'one' }]);
  const one = world.agents.get('one');
  one.held = true;
  const before = { x: one.x, y: one.y };
  world.tick(60);
  assert.deepEqual({ x: one.x, y: one.y }, before);
  one.held = false;
  one.pause = 0;
  for (let frame = 0; frame < 3; frame++) world.tick(.1);
  const previous = { x: one.x, y: one.y };
  world.tick(60);
  assert.ok(Math.hypot(one.x - previous.x, one.y - previous.y) <= one.speed * .1 + .001);
  assert.throws(() => world.tick(NaN), RangeError);
  assert.throws(() => world.tick(-1), RangeError);
});

test('hover summaries use the latest recorded agent text, never invent work or include a user message', () => {
  assert.equal(playgroundSummary({ messages: [{ user: true, message: 'Human instruction' },
    { message: 'Earlier work' }, { message: 'Fixed the flaky timer.' }, { user: true, message: 'Thanks' }] }), 'Fixed the flaky timer.');
  assert.match(playgroundSummary({ messages: [] }), /No agent update was recorded/);
  assert.equal(playgroundSummary({ messages: [{ message: 'x'.repeat(300) }] }).length, 240);
});

test('all equipment entrances and exits connect to the walking graph without entering equipment footprints', () => {
  for (const activity of Object.values(ACTIVITIES)) {
    for (const destination of [activity.entry, activity.exit, activity.line]) {
      assert.ok(walkable(destination.x, destination.y));
      assert.ok(gardenPath({ x: 246, y: 246 }, destination).length > 0);
    }
  }
  assert.equal(walkable(84, 54), false, 'ordinary walkers avoid swing frame');
  assert.equal(walkable(282, 210), false, 'ordinary walkers avoid slide');
  assert.equal(walkable(60, 258), false, 'ordinary walkers avoid stand');
});

test('boat voyages choose between one and thirty random legs, stay on the lake, and explicitly return to dock', () => {
  assert.equal(boatVoyage(() => 0).randomMoves, 1);
  assert.equal(boatVoyage(() => 1 - Number.EPSILON).randomMoves, 30);
  const random = seededRandom();
  for (let run = 0; run < 1000; run++) {
    const voyage = boatVoyage(random);
    assert.ok(voyage.randomMoves >= 1 && voyage.randomMoves <= 30);
    assert.equal(voyage.points.length, voyage.randomMoves + 1);
    for (const p of voyage.points) assert.ok(p.x >= 70 && p.x <= 126 && p.y >= 140 && p.y <= 184);
    assert.deepEqual(voyage.points.at(-1), ACTIVITIES.boat.seat);
  }
});

test('boat riders queue in FIFO order, board exclusively, return before disembarking, and allow the next rider', () => {
  const world = new PlaygroundWorld(seededRandom());
  const sessions = ['one', 'two', 'three'].map(id => ({ id }));
  world.sync(sessions);
  world.random = () => 0;
  for (const [index, agent] of [...world.agents.values()].entries()) {
    Object.assign(agent, { x: 186, y: 162 + index * 24 });
    assert.equal(world.joinActivity(agent.id, 'boat'), true);
    assert.equal(world.joinActivity(agent.id, 'swing'), false, 'one activity per critter');
  }
  const started = [];
  const finished = new Set();
  const station = world.stations.get('boat');
  for (let frame = 0; frame < 1600 && finished.size < 3; frame++) {
    world.tick(.05);
    if (station.rider && !started.includes(station.rider)) started.push(station.rider);
    assert.equal(new Set(station.queue).size, station.queue.length);
    for (const agent of world.agents.values()) {
      if (agent.activity?.phase === 'using') {
        assert.equal(station.rider, agent.id);
        assert.ok(world.boat.voyage.randomMoves <= 30);
        assert.equal(agent.x, world.boat.x);
        assert.equal(agent.y, world.boat.y);
      }
      if (agent.activity?.phase === 'exiting') {
        assert.equal(world.boat.x, ACTIVITIES.boat.seat.x);
        assert.equal(world.boat.y, ACTIVITIES.boat.seat.y);
      }
      if (!agent.activity) {
        finished.add(agent.id);
        agent.activityWait = Infinity;
        assert.ok(walkable(agent.x, agent.y));
      }
    }
    if (frame === 40) world.sync(sessions);
  }
  assert.deepEqual(started, ['one', 'two', 'three']);
  assert.equal(finished.size, 3);
  assert.equal(station.rider, null);
  assert.deepEqual(station.queue, []);
});

test('a maximum-length boat ride completes all bounded legs and puts its rider back on shore', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync([{ id: 'sailor' }]);
  const sailor = world.agents.get('sailor');
  Object.assign(sailor, ACTIVITIES.boat.entry);
  world.random = () => 1 - Number.EPSILON;
  world.joinActivity('sailor', 'boat');
  let voyage;
  for (let frame = 0; frame < 3000 && sailor.activity; frame++) {
    world.tick(.05);
    if (world.boat.voyage) voyage = world.boat.voyage;
  }
  assert.equal(voyage.randomMoves, 30);
  assert.equal(voyage.leg, voyage.points.length);
  assert.equal(sailor.activity, null);
  assert.deepEqual({ x: sailor.x, y: sailor.y }, ACTIVITIES.boat.exit);
});

test('swing, slide and bubble stand have bounded use, safe exits and independent exclusive occupancy', () => {
  const world = new PlaygroundWorld(seededRandom());
  const kinds = ['swing', 'slide', 'bubbles'];
  world.sync(kinds.map(id => ({ id })));
  for (const kind of kinds) {
    Object.assign(world.agents.get(kind), ACTIVITIES[kind].entry);
    world.joinActivity(kind, kind);
  }
  const used = new Set();
  let swingMoved = false;
  let slideMoved = false;
  for (let frame = 0; frame < 400; frame++) {
    world.tick(.05);
    for (const [id, agent] of world.agents) {
      if (agent.activity?.phase === 'using') {
        used.add(id);
        assert.equal(world.stations.get(id).rider, id);
        if (id === 'swing' && world.swingAngle !== 0) swingMoved = true;
        if (id === 'slide' && agent.y > ACTIVITIES.slide.seat.y) slideMoved = true;
      }
      if (!agent.activity) agent.activityWait = Infinity;
    }
  }
  assert.deepEqual([...used].sort(), [...kinds].sort());
  assert.ok(swingMoved && slideMoved);
  for (const [id, agent] of world.agents) {
    assert.equal(agent.activity, null);
    assert.ok(walkable(agent.x, agent.y));
    assert.equal(world.stations.get(id).rider, null);
  }
});

test('hover holds an in-progress ride and removing riders or waiters releases their reservations', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync([{ id: 'one' }, { id: 'two' }]);
  const one = world.agents.get('one');
  Object.assign(one, ACTIVITIES.boat.entry);
  world.joinActivity('one', 'boat');
  world.joinActivity('two', 'boat');
  for (let frame = 0; frame < 50; frame++) world.tick(.05);
  assert.equal(one.activity.phase, 'using');
  one.held = true;
  const before = JSON.stringify({ boat: world.boat, activity: one.activity, x: one.x, y: one.y });
  for (let frame = 0; frame < 100; frame++) world.tick(.05);
  assert.equal(JSON.stringify({ boat: world.boat, activity: one.activity, x: one.x, y: one.y }), before);
  world.sync([{ id: 'two' }]);
  assert.equal(world.stations.get('boat').rider, null);
  assert.deepEqual(world.stations.get('boat').queue, ['two']);
  assert.equal(world.boat.voyage, null);
  assert.equal(world.boat.x, ACTIVITIES.boat.seat.x);
  world.sync([]);
  assert.deepEqual(world.stations.get('boat').queue, []);
  assert.throws(() => world.joinActivity('missing', 'boat'), RangeError);
});

test('many active critters retain finite bounded state without growing duplicate queues or routes', () => {
  const world = new PlaygroundWorld(seededRandom());
  world.sync(Array.from({ length: 80 }, (_, id) => ({ id: String(id) })));
  const activities = new Set();
  for (let frame = 0; frame < 2000; frame++) {
    world.tick(.05);
    const reserved = new Set();
    for (const station of world.stations.values()) for (const id of [...station.queue, station.rider].filter(Boolean)) {
      assert.equal(reserved.has(id), false);
      reserved.add(id);
    }
    for (const agent of world.agents.values()) {
      assert.ok(Number.isFinite(agent.x) && Number.isFinite(agent.y));
      assert.ok(agent.path.length <= 1000);
      if (agent.activity?.phase === 'using') activities.add(agent.activity.kind);
      if (!agent.activity || agent.activity.phase === 'queue') assert.ok(walkable(agent.x, agent.y));
    }
  }
  assert.deepEqual([...activities].sort(), Object.keys(ACTIVITIES).sort());
});
