const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const secondsPerLetter = Math.floor(.075 * 44100) / 44100;
let synthPromise;

export function spokenRange(text) {
  const last = [...sentences.segment(text)].filter(item => item.segment.trim()).slice(-3);
  if (!last.length) return { start: 0, end: 0 };
  const end = last.at(-1).index + last.at(-1).segment.trimEnd().length;
  let start = Math.max(last[0].index + last[0].segment.search(/\S/), end - 120);
  // Keep the length cap without beginning on half of a UTF-16 surrogate pair.
  if (/[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start++;
  start += text.slice(start, end).search(/\S/);
  return { start, end };
}

export function spokenExcerpt(text) {
  const range = spokenRange(text);
  return text.slice(range.start, range.end);
}

function animalese() {
  if (!synthPromise) {
    synthPromise = new Promise((resolve, reject) => {
      const synth = new window.Animalese('/vendor/animalese.wav', () => resolve(synth), reject);
    }).catch(error => { synthPromise = undefined; throw error; });
  }
  return synthPromise;
}

export function voiceFromHash(hash) {
  if (typeof hash !== 'string' || hash.length !== 64 || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error('Voice requires a 64-character hexadecimal SHA-256 hash.');
  }
  return {
    pitch: .85 + parseInt(hash.slice(0, 8), 16) / 0xffffffff * .8,
    rate: .85 + parseInt(hash.slice(8, 16), 16) / 0xffffffff * .4,
  };
}

export class CritterVoice {
  constructor(onSpeaking, onError, onProgress = () => {}) {
    this.onSpeaking = onSpeaking;
    this.onError = onError;
    this.onProgress = onProgress;
    this.generation = 0;
    this.busy = false;
  }

  stop() {
    this.generation++;
    clearTimeout(this.timer);
    const operation = this.operation;
    this.operation = undefined;
    operation?.cancel();
    operation?.cleanup?.();
    window.speechSynthesis?.cancel();
    this.busy = false;
    this.onSpeaking(false);
    this.onProgress(null);
  }

  async play(fullText, hash, mode) {
    return this.run(hash, mode, (operation, profile) => this.playText(fullText, profile, mode, operation));
  }

  async announce(name, hash, mode) {
    return this.run(hash, mode, async (operation, profile) => {
      await this.playAudio('/notification.mp3', 1, operation, false);
      if (this.isCurrent(operation)) await this.playText(name, profile, mode, operation);
    });
  }

  isCurrent(operation) {
    return this.operation === operation && this.generation === operation.generation;
  }

  async run(hash, mode, action) {
    this.stop();
    if (mode === 'off') return;
    const operation = { generation: this.generation };
    const cancelled = new Promise(resolve => { operation.cancel = resolve; });
    this.operation = operation;
    this.busy = true;
    try {
      const profile = voiceFromHash(hash);
      await Promise.race([action(operation, profile), cancelled]);
    } catch (error) {
      if (this.isCurrent(operation)) {
        this.stop();
        this.onError(`Audio could not start: ${error.message}`);
      }
    } finally {
      if (this.isCurrent(operation)) {
        clearTimeout(this.timer);
        operation.cleanup?.();
        this.operation = undefined;
        this.busy = false;
        this.onSpeaking(false);
        this.onProgress(null);
      }
    }
  }

  async playText(fullText, profile, mode, operation) {
    if (!fullText || !this.isCurrent(operation)) return;
    const range = spokenRange(fullText);
    const text = fullText.slice(range.start, range.end);
    if (!text) return;
    const words = [...text.matchAll(/\S+/gu)].map(match => ({ start: match.index, end: match.index + match[0].length }));
    let lastWord;
    const progress = offset => {
      if (!this.isCurrent(operation)) return;
      const word = words.findLast(item => item.start <= offset) || words[0];
      if (lastWord === word) return;
      lastWord = word;
      this.onProgress({ excerptStart: range.start, excerptEnd: range.end,
        start: range.start + word.start, end: range.start + word.end });
    };
    if (mode === 'speech') {
      if (!window.speechSynthesis) throw new Error('Readable voice is not supported in this browser. Try Animalese.');
      const voices = window.speechSynthesis.getVoices().filter(item => item.localService);
      if (!voices.length) throw new Error('No local readable voice is available yet. Try Animalese or select Readable voice again once browser voices load.');
      const speech = new SpeechSynthesisUtterance(text);
      speech.voice = voices.find(item => item.lang.startsWith('en')) || voices[0];
      speech.pitch = profile.pitch;
      speech.rate = profile.rate;
      await new Promise((resolve, reject) => {
        let settled = false;
        const active = () => !settled && this.isCurrent(operation);
        const finish = error => {
          if (settled) return;
          settled = true;
          speech.onstart = speech.onboundary = speech.onend = speech.onerror = null;
          operation.cleanup = undefined;
          if (this.isCurrent(operation)) {
            clearTimeout(this.timer);
            this.onSpeaking(false);
          }
          if (error) reject(error);
          else resolve();
        };
        operation.cleanup = () => finish();
        let anchorTime;
        let anchorOffset = 0;
        const follow = () => {
          if (!active()) return;
          progress(anchorOffset + (performance.now() - anchorTime) / 1000 * 14 * speech.rate);
          this.timer = setTimeout(follow, 40);
        };
        speech.onstart = () => {
          if (!active()) return;
          anchorTime = performance.now();
          this.onSpeaking(true);
          follow();
        };
        speech.onboundary = event => {
          if (!active()) return;
          anchorOffset = event.charIndex;
          anchorTime = performance.now();
          progress(anchorOffset);
        };
        speech.onend = () => finish();
        speech.onerror = event => {
          if (!active()) return;
          finish(['canceled', 'interrupted'].includes(event.error) ? undefined :
            new Error(`Readable voice could not play (${event.error}).`));
        };
        window.speechSynthesis.speak(speech);
      });
      return;
    }
    const synth = await animalese();
    // Bound synthesis memory even if the final sentence is a very long code block.
    for (let offset = 0; offset < text.length; offset += 400) {
      if (!this.isCurrent(operation)) return;
      const wave = synth.Animalese(text.slice(offset, offset + 400), false, profile.pitch);
      await this.playAudio(wave.dataURI, profile.rate, operation, true,
        time => progress(offset + Math.floor(time / secondsPerLetter)));
    }
  }

  playAudio(source, rate, operation, speaking, progress = () => {}) {
    if (!this.isCurrent(operation)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const audio = new Audio(source);
      audio.volume = .65;
      audio.playbackRate = rate;
      let settled = false;
      const active = () => !settled && this.isCurrent(operation);
      const finish = error => {
        if (settled) return;
        settled = true;
        audio.onended = audio.onerror = audio.onplaying = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        operation.cleanup = undefined;
        if (this.isCurrent(operation)) {
          clearTimeout(this.timer);
          if (speaking) this.onSpeaking(false);
        }
        if (error) reject(error);
        else resolve();
      };
      operation.cleanup = () => finish();
      audio.onended = () => finish();
      audio.onerror = () => {
        if (active()) finish(new Error('Audio could not be decoded or played.'));
      };
      audio.onplaying = () => {
        if (!active() || !speaking) return;
        clearTimeout(this.timer);
        this.onSpeaking(true);
        const follow = () => {
          if (!active()) return;
          progress(audio.currentTime);
          this.timer = setTimeout(follow, 40);
        };
        follow();
      };
      try {
        Promise.resolve(audio.play()).catch(error => { if (active()) finish(error); });
      } catch (error) {
        finish(error);
      }
    });
  }
}
