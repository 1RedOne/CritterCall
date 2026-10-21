import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CritterVoice, spokenExcerpt, spokenRange, voiceFromHash } from '../public/audio.mjs';

const hash = '1234567890abcdef'.repeat(4);
const flush = () => new Promise(resolve => setImmediate(resolve));
let browser;

function fakeBrowser(t, { deferSynth = false } = {}) {
  const originals = new Map(['window', 'Audio', 'SpeechSynthesisUtterance']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  browser = { audio: [], utterances: [], synthesis: [], speaking: [], progress: [], errors: [], cancels: 0 };
  const state = browser;
  globalThis.window = {
    Animalese: class {
      constructor(source, loaded) {
        assert.equal(source, '/vendor/animalese.wav');
        state.loadSynth = loaded;
        if (!deferSynth) queueMicrotask(loaded);
      }
      Animalese(text, shorten, pitch) {
        browser.synthesis.push({ text, shorten, pitch });
        return { dataURI: 'data:audio/wav;base64,local' };
      }
    },
    speechSynthesis: {
      cancel() { state.cancels++; },
      getVoices() { return [{ localService: false, lang: 'en-US' }, { localService: true, lang: 'en-US' }]; },
      speak(value) { state.utterances.push(value); },
    },
  };
  globalThis.Audio = class {
    constructor(source) { this.source = source; this.currentTime = 0; state.audio.push(this); }
    play() { this.played = true; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(key) { assert.equal(key, 'src'); this.removed = true; }
    load() { this.released = true; }
  };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  state.voice = new CritterVoice(value => state.speaking.push(value),
    error => state.errors.push(error), value => state.progress.push(value));
  t.after(() => {
    state.voice.stop();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
  });
  return state;
}

test('voice profiles are deterministic, case-insensitive, and pleasantly bounded', () => {
  assert.deepEqual(voiceFromHash(hash), voiceFromHash(hash.toUpperCase()));
  assert.deepEqual(voiceFromHash('0'.repeat(64)), { pitch: .85, rate: .85 });
  const high = voiceFromHash('f'.repeat(64));
  assert.ok(Math.abs(high.pitch - 1.65) < 1e-12);
  assert.equal(high.rate, 1.25);
  assert.deepEqual(voiceFromHash(hash), voiceFromHash(hash));
});

test('voice profiles reject anything other than a SHA-256 hexadecimal string', () => {
  for (const invalid of [null, undefined, 0, {}, '', 'f'.repeat(63), 'f'.repeat(65), 'g'.repeat(64),
    'f'.repeat(64) + '\n']) {
    assert.throws(() => voiceFromHash(invalid), /64-character hexadecimal SHA-256/);
  }
});

test('distinct hash bytes independently control pitch and speed without randomness', () => {
  const low = voiceFromHash('0'.repeat(64));
  const pitch = voiceFromHash('ffffffff' + '0'.repeat(56));
  const speed = voiceFromHash('00000000ffffffff' + '0'.repeat(48));
  assert.notEqual(low.pitch, pitch.pitch);
  assert.equal(low.rate, pitch.rate);
  assert.notEqual(low.rate, speed.rate);
  assert.equal(low.pitch, speed.pitch);
});

test('playback includes only the last three sentences of a long update', () => {
  const message = 'Earlier context. More background. The change is ready. The tests pass! Can you review it?';
  assert.equal(spokenExcerpt(message), 'The change is ready. The tests pass! Can you review it?');
});

test('playback preserves shorter messages, including an unfinished last sentence', () => {
  for (const message of ['Ready', 'Ready now.', 'Ready now. Any questions?', 'First step. Second step! Last thought']) {
    assert.equal(spokenExcerpt(message), message);
  }
});

test('sentence extraction handles whitespace, decimals, and quoted punctuation', () => {
  assert.equal(spokenExcerpt('  Earlier context.\n\nVersion 2.5 is ready.  She said "Looks good!"\nAny questions?  '),
    'Version 2.5 is ready.  She said "Looks good!"\nAny questions?');
  assert.equal(spokenExcerpt(' \n\t '), '');
  assert.equal(spokenExcerpt(''), '');
});

test('spoken range retains exact transcript offsets for moving highlights', () => {
  const text = '  Older update. \nEarlier context. \nReady now.  Looks good! Need help?  ';
  const range = spokenRange(text);
  assert.equal(text.slice(range.start, range.end), 'Ready now.  Looks good! Need help?');
  assert.equal(range.start, text.indexOf('Ready now.'));
  assert.equal(range.end, text.lastIndexOf('?') + 1);
  assert.deepEqual(spokenRange(' \n '), { start: 0, end: 0 });
});

test('playback chooses the shorter of the last three sentences and the last 120 characters', () => {
  for (const length of [119, 120, 121, 905]) {
    const text = 'x'.repeat(length);
    assert.equal(spokenExcerpt(text), text.slice(-120));
    assert.deepEqual(spokenRange(text), { start: Math.max(0, length - 120), end: length });
  }
  const shortTail = 'First. Second! Third?';
  assert.equal(spokenExcerpt('Old. '.repeat(100) + shortTail), shortTail);
  const longTail = 'Earlier details. ' + 'Long middle sentence '.repeat(8) + '. Final words?';
  assert.equal(spokenExcerpt(longTail), longTail.slice(-120));
  const padded = ` \n${'x'.repeat(150)}  \n`;
  assert.equal(spokenExcerpt(padded), 'x'.repeat(120));
  assert.deepEqual(spokenRange(padded), { start: 32, end: 152 });
});

test('character truncation preserves exact offsets without splitting a surrogate pair', () => {
  const text = `A\u{1f98a}${'x'.repeat(119)}`;
  const range = spokenRange(text);
  assert.equal(range.start, 3);
  assert.equal(range.end, text.length);
  assert.equal(spokenExcerpt(text), 'x'.repeat(119));
  const unicode = '\u{1f98a}'.repeat(100);
  assert.equal(spokenExcerpt(unicode), '\u{1f98a}'.repeat(60));
  assert.equal(spokenExcerpt(unicode).length, 120);
});

test('readable voice uses seeded settings, exact excerpt offsets, and waits until completion', async t => {
  const state = fakeBrowser(t);
  const { voice, progress } = state;
  const full = 'Earlier context. Another old update. Ready now. Looks good! Need help?';
  let complete = false;
  const playing = voice.play(full, hash, 'speech').then(() => { complete = true; });
  const utterance = state.utterances[0];
  assert.equal(voice.busy, true);
  assert.equal(state.speaking.includes(true), false, 'Loading must not animate the character');
  assert.equal(utterance.text, 'Ready now. Looks good! Need help?');
  assert.equal(utterance.voice.localService, true);
  assert.equal(utterance.pitch, voiceFromHash(hash).pitch);
  assert.equal(utterance.rate, voiceFromHash(hash).rate);
  await flush();
  assert.equal(complete, false);
  utterance.onstart();
  assert.equal(state.speaking.at(-1), true);
  assert.equal(full.slice(progress.at(-1).start, progress.at(-1).end), 'Ready');
  assert.equal(progress.at(-1).excerptStart, full.indexOf('Ready'));
  assert.equal(progress.at(-1).excerptEnd, full.length);
  utterance.onboundary({ charIndex: utterance.text.indexOf('Looks') });
  assert.equal(full.slice(progress.at(-1).start, progress.at(-1).end), 'Looks');
  const staleBoundary = utterance.onboundary;
  utterance.onend();
  await playing;
  assert.equal(complete, true);
  assert.equal(voice.busy, false);
  assert.equal(state.speaking.at(-1), false);
  assert.equal(progress.at(-1), null);
  staleBoundary({ charIndex: 0 });
  assert.equal(progress.at(-1), null, 'Finished speech cannot restore a stale highlight');
  assert.deepEqual(state.errors, []);
});

test('stop resolves readable speech waits and stale callbacks cannot disturb newer speech', async t => {
  const state = fakeBrowser(t);
  const old = state.voice.play('Old words.', hash, 'speech');
  const utterance = state.utterances[0];
  utterance.onstart();
  const stale = { start: utterance.onstart, boundary: utterance.onboundary, end: utterance.onend, error: utterance.onerror };
  state.voice.stop();
  await old;
  assert.equal(state.voice.busy, false);
  const newer = state.voice.play('New words.', hash, 'speech');
  const current = state.utterances[1];
  current.onstart();
  const progress = state.progress.at(-1);
  stale.start();
  stale.boundary({ charIndex: 1 });
  stale.end();
  stale.error({ error: 'synthesis-failed' });
  await flush();
  assert.equal(state.voice.busy, true);
  assert.equal(state.speaking.at(-1), true);
  assert.equal(state.progress.at(-1), progress);
  assert.deepEqual(state.errors, []);
  current.onend();
  await newer;
});

test('Animalese loading is busy and cancellable without starting stale audio', async t => {
  const state = fakeBrowser(t, { deferSynth: true });
  const playing = state.voice.play('Old words.', hash, 'chatter');
  assert.equal(state.voice.busy, true);
  assert.equal(state.speaking.includes(true), false);
  state.voice.stop();
  await playing;
  assert.equal(state.voice.busy, false, 'Cancellation must settle even while the local synth is still loading');
  state.loadSynth();
  await flush();
  assert.equal(state.voice.busy, false);
  assert.equal(state.audio.length, 0);
  assert.equal(state.synthesis.length, 0);
  assert.deepEqual(state.errors, []);
});

test('Animalese uses seeded pitch and playback rate, moving offsets, and completion waits', async t => {
  const state = fakeBrowser(t);
  const full = 'Old text. Older text. Ready now. Looks good! Need help?';
  let complete = false;
  const playing = state.voice.play(full, hash, 'chatter').then(() => { complete = true; });
  await flush();
  const audio = state.audio[0];
  assert.equal(state.voice.busy, true);
  assert.equal(complete, false);
  assert.equal(state.synthesis[0].pitch, voiceFromHash(hash).pitch);
  assert.equal(audio.playbackRate, voiceFromHash(hash).rate);
  assert.equal(state.synthesis[0].text, spokenExcerpt(full));
  audio.onplaying();
  assert.equal(state.speaking.at(-1), true);
  assert.equal(full.slice(state.progress.at(-1).start, state.progress.at(-1).end), 'Ready');
  audio.currentTime = 11 * Math.floor(.075 * 44100) / 44100;
  audio.onplaying();
  assert.equal(full.slice(state.progress.at(-1).start, state.progress.at(-1).end), 'Looks');
  audio.onended();
  await playing;
  assert.equal(complete, true);
  assert.equal(state.voice.busy, false);
  assert.equal(state.progress.at(-1), null);
  assert.equal(audio.released, true);
  assert.deepEqual(state.errors, []);
});

test('Animalese caps a long sentence at 120 characters and awaits its completion', async t => {
  const state = fakeBrowser(t);
  const text = 'x'.repeat(905);
  let complete = false;
  const playing = state.voice.play(text, hash, 'chatter').then(() => { complete = true; });
  await flush();
  assert.equal(state.audio.length, 1);
  assert.equal(state.synthesis[0].text, text.slice(-120));
  assert.equal(complete, false);
  assert.equal(state.voice.busy, true);
  state.audio[0].onplaying();
  assert.equal(state.progress.at(-1).excerptStart, text.length - 120);
  assert.equal(state.progress.at(-1).excerptEnd, text.length);
  state.audio[0].onended();
  await playing;
  assert.equal(complete, true);
  assert.equal(state.voice.busy, false);
  assert.equal(state.audio.length, 1);
});

test('readable speech applies the same 120-character cap and highlight offsets', async t => {
  const state = fakeBrowser(t);
  const text = 'Earlier information. ' + 'abcdef '.repeat(40) + 'Last words!';
  const playing = state.voice.play(text, hash, 'speech');
  const utterance = state.utterances[0];
  assert.equal(utterance.text, text.slice(-120));
  utterance.onstart();
  assert.equal(state.progress.at(-1).excerptStart, text.length - 120);
  assert.equal(state.progress.at(-1).excerptEnd, text.length);
  utterance.onend();
  await playing;
  assert.equal(state.voice.busy, false);
});

test('cancelled Animalese resolves and releases audio; stale events cannot animate newer playback', async t => {
  const state = fakeBrowser(t);
  const old = state.voice.play('Old words.', hash, 'chatter');
  await flush();
  const audio = state.audio[0];
  const stale = { playing: audio.onplaying, ended: audio.onended, error: audio.onerror };
  const newer = state.voice.play('New words.', hash, 'speech');
  const utterance = state.utterances[0];
  utterance.onstart();
  await old;
  stale.playing();
  stale.ended();
  stale.error();
  assert.equal(audio.paused, true);
  assert.equal(audio.removed, true);
  assert.equal(audio.released, true);
  assert.equal(state.voice.busy, true);
  assert.equal(state.speaking.at(-1), true);
  assert.deepEqual(state.errors, []);
  utterance.onend();
  await newer;
});

for (const mode of ['speech', 'chatter']) {
  test(`announcement plays bell before ${mode} name and waits across both stages`, async t => {
    const state = fakeBrowser(t);
    let complete = false;
    const announcing = state.voice.announce('Ada', hash, mode).then(() => { complete = true; });
    const bell = state.audio[0];
    assert.equal(bell.source, '/notification.mp3');
    assert.equal(bell.playbackRate, 1);
    assert.equal(state.voice.busy, true);
    bell.onplaying();
    await flush();
    assert.equal(complete, false);
    assert.equal(state.speaking.includes(true), false);
    assert.equal(state.utterances.length, 0);
    assert.equal(state.synthesis.length, 0);
    bell.onended();
    await flush();
    assert.equal(bell.released, true);
    assert.equal(state.voice.busy, true);
    assert.equal(complete, false);
    if (mode === 'speech') {
      const speech = state.utterances[0];
      assert.equal(speech.text, 'Ada');
      assert.equal(speech.pitch, voiceFromHash(hash).pitch);
      assert.equal(speech.rate, voiceFromHash(hash).rate);
      speech.onstart();
      assert.equal(state.speaking.at(-1), true);
      assert.deepEqual(state.progress.at(-1), { excerptStart: 0, excerptEnd: 3, start: 0, end: 3 });
      speech.onend();
    } else {
      assert.equal(state.synthesis[0].text, 'Ada');
      assert.equal(state.synthesis[0].pitch, voiceFromHash(hash).pitch);
      const audio = state.audio[1];
      assert.equal(audio.playbackRate, voiceFromHash(hash).rate);
      audio.onplaying();
      assert.equal(state.speaking.at(-1), true);
      audio.onended();
    }
    await announcing;
    assert.equal(state.voice.busy, false);
    assert.equal(state.speaking.at(-1), false);
    assert.equal(state.progress.at(-1), null);
    assert.deepEqual(state.errors, []);
  });
}

test('stop during a bell cancels the chain without later speaking or affecting a new call', async t => {
  const state = fakeBrowser(t);
  const announcing = state.voice.announce('Ada', hash, 'speech');
  const bell = state.audio[0];
  const ended = bell.onended;
  state.voice.stop();
  await announcing;
  assert.equal(state.voice.busy, false);
  assert.equal(bell.released, true);
  const newer = state.voice.play('New speech.', hash, 'speech');
  state.utterances[0].onstart();
  ended();
  await flush();
  assert.equal(state.utterances.length, 1);
  assert.equal(state.voice.busy, true);
  assert.equal(state.speaking.at(-1), true);
  state.utterances[0].onend();
  await newer;
  assert.deepEqual(state.errors, []);
});

test('stop during an announcement name settles the whole chain', async t => {
  const state = fakeBrowser(t);
  const announcing = state.voice.announce('Ada', hash, 'speech');
  state.audio[0].onended();
  await flush();
  state.utterances[0].onstart();
  state.voice.stop();
  await announcing;
  assert.equal(state.voice.busy, false);
  assert.equal(state.progress.at(-1), null);
  assert.equal(state.speaking.at(-1), false);
  assert.deepEqual(state.errors, []);
});

test('stop during a long Animalese announcement cancels its capped name', async t => {
  const state = fakeBrowser(t);
  const announcing = state.voice.announce('A'.repeat(850), hash, 'chatter');
  state.audio[0].onended();
  await flush();
  const nameAudio = state.audio[1];
  assert.equal(state.synthesis[0].text.length, 120);
  nameAudio.onplaying();
  state.voice.stop();
  await announcing;
  await flush();
  assert.equal(state.voice.busy, false);
  assert.equal(nameAudio.released, true);
  assert.equal(state.audio.length, 2);
  assert.equal(state.synthesis.length, 1);
  assert.equal(state.progress.at(-1), null);
  assert.equal(state.speaking.at(-1), false);
  assert.deepEqual(state.errors, []);
});

test('stop resolves queued native speech even before its start event', async t => {
  const state = fakeBrowser(t);
  const playing = state.voice.play('Queued words.', hash, 'speech');
  assert.equal(state.voice.busy, true);
  assert.equal(state.speaking.includes(true), false);
  state.voice.stop();
  await playing;
  assert.equal(state.voice.busy, false);
  assert.equal(state.utterances[0].onstart, null);
  assert.deepEqual(state.errors, []);
});

test('off mode does not load or speak either an announcement or ordinary text', async t => {
  const state = fakeBrowser(t);
  await state.voice.announce('Ada', hash, 'off');
  await state.voice.play('Words.', hash, 'off');
  assert.equal(state.voice.busy, false);
  assert.equal(state.audio.length, 0);
  assert.equal(state.utterances.length, 0);
  assert.equal(state.synthesis.length, 0);
  assert.equal(state.speaking.includes(true), false);
});

test('invalid hashes and missing local speech report explicit errors and clear busy state', async t => {
  const state = fakeBrowser(t);
  await state.voice.play('Words.', 'bad', 'speech');
  assert.match(state.errors.pop(), /SHA-256/);
  await state.voice.announce('Ada', 'bad', 'chatter');
  assert.match(state.errors.pop(), /SHA-256/);
  assert.equal(state.audio.length, 0);
  window.speechSynthesis.getVoices = () => [{ localService: false, lang: 'en-US' }];
  await state.voice.play('Words.', hash, 'speech');
  assert.match(state.errors.pop(), /No local readable voice/);
  delete window.speechSynthesis;
  await state.voice.play('Words.', hash, 'speech');
  assert.match(state.errors.pop(), /not supported/);
  assert.equal(state.voice.busy, false);
  assert.equal(state.progress.at(-1), null);
});

test('native speech failures settle waits; native cancellation is not an error', async t => {
  const state = fakeBrowser(t);
  const failed = state.voice.play('Words.', hash, 'speech');
  state.utterances[0].onerror({ error: 'synthesis-failed' });
  await failed;
  assert.equal(state.voice.busy, false);
  assert.match(state.errors.pop(), /synthesis-failed/);
  for (const error of ['canceled', 'interrupted']) {
    const cancelled = state.voice.play('Words.', hash, 'speech');
    state.utterances.at(-1).onerror({ error });
    await cancelled;
    assert.equal(state.voice.busy, false);
  }
  assert.deepEqual(state.errors, []);
});

test('bell decoding and playback rejection report errors without starting the name', async t => {
  const state = fakeBrowser(t);
  const failed = state.voice.announce('Ada', hash, 'speech');
  state.audio[0].onerror();
  await failed;
  assert.match(state.errors.pop(), /decoded or played/);
  assert.equal(state.voice.busy, false);
  assert.equal(state.utterances.length, 0);
  globalThis.Audio.prototype.play = () => Promise.reject(new Error('Playback denied'));
  await state.voice.announce('Ada', hash, 'speech');
  assert.match(state.errors.pop(), /Playback denied/);
  assert.equal(state.voice.busy, false);
  assert.equal(state.utterances.length, 0);
  assert.equal(state.audio.at(-1).released, true);
});

test('legacy two-callback constructor and repeated same-hash speech remain supported', async t => {
  const state = fakeBrowser(t);
  const voice = new CritterVoice(() => {}, error => assert.fail(error));
  state.voice = voice;
  for (let index = 0; index < 2; index++) {
    const playing = voice.play('Words.', hash, 'speech');
    const speech = state.utterances[index];
    speech.onstart();
    speech.onend();
    await playing;
  }
  assert.equal(state.utterances[0].pitch, state.utterances[1].pitch);
  assert.equal(state.utterances[0].rate, state.utterances[1].rate);
});
