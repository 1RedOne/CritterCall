const $ = (id) => document.getElementById(id);
const traitKeys = ['body', 'background', 'face', 'accessory', 'decoration', 'palette'];
const partKeys = ['bodies', 'backgrounds', 'faces', 'accessories', 'decorations', 'palettes'];
const layerKeys = ['background', 'character', 'foreground'];
const selects = [...document.querySelectorAll('[data-trait]')];
const layerButtons = [...document.querySelectorAll('[data-preview-layer], [data-download-layer]')];
const seed = $('seed-text');
const stage = $('character-stage');
const dialog = $('layer-dialog');
const objectUrls = new Map();
let kit;
let result = null;
let revision = 0;
let inputTimer;
let serviceController;
let dialogLayer = null;
let voiceKit;
let voice;
let voiceSpeaking = false;
let voiceRevision = 0;

const friendly = (value) => value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const overrides = () => Object.fromEntries(selects.filter((select) => select.value).map((select) => [select.dataset.trait, select.value]));

function showError(message) {
  $('lab-error').textContent = message;
  $('lab-error').hidden = !message;
}

function updateExample() {
  const text = JSON.stringify(seed.value);
  const options = JSON.stringify(overrides(), null, 2);
  $('code-example').textContent = `import { hashText, characterFromHash } from '/characters.mjs';
import { voiceFromHash } from '/audio.mjs';

const text = ${text};
const overrides = ${options};
const hash = await hashText(text); // browser SHA-256
const character = characterFromHash(hash, overrides);
const { pitch, rate } = voiceFromHash(hash);
// Stack character.layers.{background,character,foreground}
// as three aligned SVG images (320 × 240).

// Optional: same generator on this local server.
const response = await fetch('/api/character', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, overrides })
});
if (!response.ok) throw new Error('Character API failed');
const serverCharacter = await response.json();`;
}

function validateResult(value, expectedHash) {
  if (!value || value.hash !== expectedHash || value.width !== 320 || value.height !== 240) {
    throw new Error('The generator returned an invalid hash or scene size.');
  }
  for (let i = 0; i < traitKeys.length; i += 1) {
    if (!kit.CHARACTER_PARTS[partKeys[i]].includes(value.traits?.[traitKeys[i]])) {
      throw new Error(`The generator returned an unknown ${traitKeys[i]} trait.`);
    }
  }
  for (const layer of layerKeys) {
    if (typeof value.layers?.[layer] !== 'string' || !/^\s*<svg[\s>]/i.test(value.layers[layer])) {
      throw new Error(`The generator returned an invalid ${layer} SVG layer.`);
    }
  }
  return value;
}

function setLayerControls(enabled) {
  for (const button of layerButtons) button.disabled = !enabled;
}

function render(value, source) {
  result = value;
  for (const layer of layerKeys) {
    const uri = svgUri(value.layers[layer]);
    for (const prefix of ['preview', 'layer']) {
      const image = $(`${prefix}-${layer}`);
      image.src = uri;
      image.hidden = false;
    }
  }
  $('preview-placeholder').hidden = true;
  stage.setAttribute('aria-busy', 'false');
  stage.setAttribute('aria-label', `${friendly(value.traits.palette)} ${friendly(value.traits.body)} character with ${friendly(value.traits.face)} face, ${friendly(value.traits.accessory)} accessory, ${friendly(value.traits.background)} background and ${friendly(value.traits.decoration)} decoration.`);
  $('seed-hash').textContent = value.hash;
  $('render-source').textContent = source === 'service' ? 'LOCAL API PREVIEW' : 'BROWSER PREVIEW';
  $('generation-status').textContent = seed.value.length ? 'Ready · exact text → SHA-256 → deterministic character.' : 'Ready · empty text has its own SHA-256 seed, too.';
  $('resolved-traits').replaceChildren(...traitKeys.map((key) => {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = friendly(key);
    description.textContent = friendly(value.traits[key]);
    group.append(term, description);
    return group;
  }));
  const count = Object.keys(overrides()).length;
  $('recipe-mode').textContent = count ? `${count} manual ${count === 1 ? 'override' : 'overrides'}` : 'Seeded automatically';
  $('service-preview').disabled = false;
  setLayerControls(true);
  $('download-status').textContent = 'SVG previews and downloads are ready. Transparent layers include no background fill.';
  updateVoiceSettings();
}

function invalidate() {
  revision += 1;
  stopVoice('Voice stopped for the updated character. Press Preview voice when ready.');
  clearTimeout(inputTimer);
  serviceController?.abort();
  serviceController = undefined;
  result = null;
  showError('');
  if (voice) {
    $('voice-error').hidden = true;
    $('voice-error').textContent = '';
  }
  stage.setAttribute('aria-busy', 'true');
  stage.setAttribute('aria-label', 'Updating character preview');
  $('preview-placeholder').textContent = 'A little character development…';
  $('preview-placeholder').hidden = false;
  for (const layer of layerKeys) {
    for (const prefix of ['preview', 'layer']) $(`${prefix}-${layer}`).hidden = true;
  }
  if (dialog.open) dialog.close();
  $('seed-hash').textContent = 'Computing SHA-256…';
  $('generation-status').textContent = 'Updating your local browser preview…';
  $('service-status').textContent = 'Optional: compare the same seed and overrides with the local service.';
  $('service-preview').disabled = true;
  $('seed-count').textContent = `${seed.value.length} / 4096`;
  $('resolved-traits').replaceChildren();
  $('recipe-mode').textContent = 'Updating…';
  $('voice-pitch').textContent = '—';
  $('voice-rate').textContent = '—';
  $('preview-voice').disabled = true;
  $('download-status').textContent = 'Waiting for the current seed before enabling downloads.';
  setLayerControls(false);
  updateExample();
  return revision;
}

async function generate(currentRevision) {
  if (!kit || currentRevision !== revision) return;
  const text = seed.value;
  const selected = overrides();
  try {
    if (text.length > 4096) throw new Error('Please shorten your seed to 4096 characters or fewer.');
    const hash = await kit.hashText(text);
    if (currentRevision !== revision) return;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('SHA-256 did not return a valid 64-character hash.');
    const value = validateResult(kit.characterFromHash(hash, selected), hash);
    if (currentRevision !== revision) return;
    render(value, 'browser');
  } catch (error) {
    if (currentRevision !== revision) return;
    $('seed-hash').textContent = 'No current hash available.';
    $('generation-status').textContent = 'Could not generate this character.';
    $('preview-placeholder').textContent = 'Your critter could not be rendered. See the error message.';
    stage.setAttribute('aria-label', 'Character preview unavailable');
    stage.setAttribute('aria-busy', 'false');
    showError(`Browser preview failed: ${error.message}`);
  }
}

function scheduleGeneration(delay = 180) {
  const currentRevision = invalidate();
  inputTimer = setTimeout(() => generate(currentRevision), delay);
}

function updateMotion() {
  stage.classList.toggle('speaking', $('preview-speaking').checked || voiceSpeaking);
  stage.classList.toggle('hand-raised', $('preview-hand').checked);
}

function updateVoiceSettings() {
  if (!voiceKit || !result) return;
  const profile = voiceKit.voiceFromHash(result.hash);
  $('voice-pitch').textContent = profile.pitch.toFixed(4);
  $('voice-rate').textContent = profile.rate.toFixed(4);
  $('preview-voice').disabled = false;
  if (!voice?.busy) $('voice-status').textContent = 'Ready when you are. Audio never plays automatically.';
}

function stopVoice(message = 'Voice preview stopped.') {
  voiceRevision += 1;
  voice?.stop();
  voiceSpeaking = false;
  updateMotion();
  $('stop-voice').disabled = true;
  if (voice) $('voice-status').textContent = message;
}

async function previewVoice() {
  if (!voice || !result) return;
  const currentVoiceRevision = ++voiceRevision;
  let failed = false;
  $('voice-error').hidden = true;
  $('voice-error').textContent = '';
  $('voice-status').textContent = 'Preparing your little voice…';
  $('stop-voice').disabled = false;
  voice.onError = (message) => {
    if (currentVoiceRevision !== voiceRevision) return;
    failed = true;
    $('voice-error').textContent = message;
    $('voice-error').hidden = false;
    $('voice-status').textContent = 'Voice preview failed. Try another mode or check browser audio permissions.';
  };
  try {
    await voice.play('Hello! Ready to help?', result.hash, $('voice-mode').value);
    if (currentVoiceRevision === voiceRevision && !failed) $('voice-status').textContent = 'Voice preview finished. Same hash, same pitch and rate.';
  } catch (error) {
    if (currentVoiceRevision === voiceRevision) voice.onError(`Voice preview failed: ${error.message}`);
  } finally {
    if (currentVoiceRevision === voiceRevision) $('stop-voice').disabled = true;
  }
}

function previewLayer(layer) {
  if (!result || !layerKeys.includes(layer)) return;
  dialogLayer = layer;
  $('layer-dialog-title').textContent = `${friendly(layer)} SVG preview`;
  $('dialog-layer-image').src = svgUri(result.layers[layer]);
  $('dialog-layer-image').alt = `Isolated ${layer} SVG layer, 320 by 240`;
  dialog.showModal();
}

function revokeDownload(url) {
  clearTimeout(objectUrls.get(url));
  URL.revokeObjectURL(url);
  objectUrls.delete(url);
}

function downloadLayer(layer) {
  if (!result || !layerKeys.includes(layer)) return;
  let url;
  let anchor;
  try {
    url = URL.createObjectURL(new Blob([result.layers[layer]], { type: 'image/svg+xml;charset=utf-8' }));
    objectUrls.set(url, setTimeout(() => revokeDownload(url), 30000));
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `critter-${result.hash.slice(0, 12)}-${layer}.svg`;
    document.body.append(anchor);
    anchor.click();
    $('download-status').textContent = `${friendly(layer)} SVG download requested. Check your browser downloads.`;
  } catch (error) {
    if (url) revokeDownload(url);
    showError(`SVG download failed: ${error.message}`);
  } finally {
    anchor?.remove();
  }
}

async function previewService() {
  if (!kit || !result) return;
  const currentRevision = revision;
  const expectedHash = result.hash;
  const text = seed.value;
  const selected = overrides();
  serviceController?.abort();
  const controller = new AbortController();
  serviceController = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  $('service-preview').disabled = true;
  $('service-status').textContent = 'Requesting this character from the local API…';
  showError('');
  try {
    const response = await fetch('/api/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text, overrides: selected }),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        if (typeof body.error === 'string') detail = ` ${body.error.slice(0, 300)}`;
      } catch { /* The HTTP status is still useful for non-JSON errors. */ }
      throw new Error(`HTTP ${response.status}.${detail}`);
    }
    const value = validateResult(await response.json(), expectedHash);
    if (currentRevision !== revision || serviceController !== controller) return;
    render(value, 'service');
    $('service-status').textContent = 'Local API succeeded · the service-rendered character is shown above.';
  } catch (error) {
    if (currentRevision !== revision || serviceController !== controller) return;
    const message = timedOut ? 'The local API did not respond within 15 seconds.' : error.message;
    $('service-status').textContent = 'Local API failed. The browser preview remains visible; it is not an API result.';
    showError(`Local API preview failed: ${message}`);
  } finally {
    clearTimeout(timeout);
    if (currentRevision === revision && serviceController === controller) {
      $('service-preview').disabled = !result;
      serviceController = undefined;
    }
  }
}

seed.addEventListener('input', () => scheduleGeneration());
for (const select of selects) select.addEventListener('change', () => scheduleGeneration(0));
$('reset-seed').addEventListener('click', () => {
  for (const select of selects) select.value = '';
  scheduleGeneration(0);
});
$('service-preview').addEventListener('click', previewService);
$('preview-speaking').addEventListener('change', updateMotion);
$('preview-hand').addEventListener('change', updateMotion);
$('preview-voice').addEventListener('click', previewVoice);
$('stop-voice').addEventListener('click', () => stopVoice());
$('voice-mode').addEventListener('change', () => stopVoice('Voice mode changed. Press Preview voice to hear it.'));
for (const button of layerButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.previewLayer) previewLayer(button.dataset.previewLayer);
    else downloadLayer(button.dataset.downloadLayer);
  });
}
$('close-layer-dialog').addEventListener('click', () => dialog.close());
$('dialog-download').addEventListener('click', () => downloadLayer(dialogLayer));
dialog.addEventListener('close', () => {
  $('dialog-layer-image').removeAttribute('src');
  dialogLayer = null;
});
window.addEventListener('pagehide', () => {
  clearTimeout(inputTimer);
  serviceController?.abort();
  stopVoice();
  for (const url of objectUrls.keys()) revokeDownload(url);
});

for (const layer of layerKeys) {
  for (const prefix of ['preview', 'layer']) {
    $(`${prefix}-${layer}`).addEventListener('error', () => {
      if (result) showError(`The ${layer} SVG image could not be displayed. Check the local SVG kit and image content security policy.`);
    });
  }
}

$('seed-count').textContent = `${seed.value.length} / 4096`;
updateExample();
try {
  kit = await import('/characters.mjs');
  if (typeof kit.hashText !== 'function' || typeof kit.characterFromHash !== 'function') {
    throw new Error('The local character kit is missing its generator exports.');
  }
  for (let index = 0; index < traitKeys.length; index += 1) {
    const names = kit.CHARACTER_PARTS?.[partKeys[index]];
    if (!Array.isArray(names) || !names.length || names.some((name) => typeof name !== 'string' || !name)) {
      throw new Error(`The character kit has no valid ${partKeys[index]} list.`);
    }
    const select = selects.find((control) => control.dataset.trait === traitKeys[index]);
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = friendly(name);
      select.append(option);
    }
  }
  $('trait-controls').disabled = false;
  $('reset-seed').disabled = false;
  await generate(invalidate());
} catch (error) {
  stage.setAttribute('aria-busy', 'false');
  stage.setAttribute('aria-label', 'Character kit unavailable');
  $('preview-placeholder').textContent = 'The character kit is unavailable.';
  $('seed-hash').textContent = 'Local character kit required.';
  $('generation-status').textContent = 'Could not load the local character kit.';
  showError(`Character Lab could not start: ${error.message}. Make sure this page is served from the local Critter Call server and reload.`);
}

try {
  voiceKit = await import('/audio.mjs');
  if (typeof voiceKit.voiceFromHash !== 'function' || typeof voiceKit.CritterVoice !== 'function') {
    throw new Error('The local audio module is missing its hash-based voice exports.');
  }
  voice = new voiceKit.CritterVoice((speaking) => {
    voiceSpeaking = speaking;
    updateMotion();
    if (speaking) $('voice-status').textContent = 'Your critter is speaking…';
  }, (message) => {
    $('voice-error').textContent = message;
    $('voice-error').hidden = false;
  });
  $('voice-status').textContent = 'Generate a character to preview its voice.';
  updateVoiceSettings();
} catch (error) {
  $('voice-status').textContent = 'Voice preview unavailable. Character rendering still works.';
  $('voice-error').textContent = `Could not load local voice preview: ${error.message}`;
  $('voice-error').hidden = false;
}
