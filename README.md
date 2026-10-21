# Critter Call

A local video-call-style companion for your **12 most recently used Copilot tab
sessions**. Each session gets a stable quirky name and a layered blob character,
raised hands, and a private conversation pane. This is a developer tool, not
part of the Guest Configuration services or their deployment.

## Run

Requires **Node.js 24 or newer** and a modern browser. No packages, keys, build
step, camera, or microphone are needed.

```powershell
cd C:\git\critterCall
npm start
```

Open **http://127.0.0.1:47821**. Use **Demo room** to try twelve fictional
characters, questions, and replies without contacting real agents. `npm run demo`
starts a demo-only server. Set `$env:PORT` to use a different port.

The **first click on each card per page visit** reads only the message's
**last three sentences or last 120 characters, whichever is shorter**, in
**Animalese**, while the full text remains shown. The tail may begin mid-sentence;
truncation never splits a UTF-16 surrogate pair.
Later clicks select that card without automatically reading again; use
**Play again** for an intentional replay. The spoken excerpt
is softly highlighted, with a stronger word highlight following playback.
**Readable voice** follows the same limit using an installed local browser speech
voice; **Silent** disables playback. Stop playback at any time. Animalese follows
the generated audio's current playback position. Readable voice uses browser
word-boundary events with approximate timing between events.

After you enable audio by interacting with a card or sound control, a newly
raised hand plays the supplied bell, then **only that agent's name**. Existing
hands on initial page load do not announce. Alerts wait behind active playback,
coalesce per session per refresh, and skip hands that have been answered,
dismissed, or moved out of the room before their turn. Silent mode suppresses
both sounds; hidden pages pause playback. Stop also clears queued alerts.
Pitch and speaking speed are derived from the character's SHA-256 hash, so
each critter keeps the same voice across visits. The bell always plays at its
normal speed. Browser interaction is required before automatic sound can play.

Chatter uses local copies of Acedio's `animalese.js`, its audio bank, and
`riffwave.js`, pinned to revision `6f18a909df12cdddab59438640ac8019b78fac2f`.
The engine is MIT licensed, the audio by **Josh Simmons** is **CC BY 4.0**,
and `riffwave.js` is public domain. See `public\vendor\LICENSE.md` and
`public\vendor\NOTICE.txt`; attribution is also linked from the page. No scripts,
audio, or message text are fetched from third-party sites during use.
`public\notification.mp3` is the notification sound supplied by the user,
copied from `universfield-clear-bell-chime-487898.mp3`; it is not part of the
Animalese distribution.

## Character kit and lab

Open **http://127.0.0.1:47821/character-lab** to experiment with a text seed,
trait overrides, character motion, voice previews, and separate SVG downloads.
The original kit includes **10 body silhouettes**, **8 backgrounds**,
**8 expressions**, **10 accessories**, **7 decoration choices**, and **8 palettes**.
Rounded blobs, expressive faces, and desks/laptops make each tile feel like a
little corporate-kawaii webcam. Background, character, and desk/foreground
are separate aligned **320 x 240 SVGs**. Only the character squishes and
stretches for hands and speech; reduced-motion settings disable animation.

`public\characters.mjs` runs in both browsers and Node:

```js
import { hashText, characterFromHash, characterFromText } from './characters.mjs';
const hash = await hashText('Rapid Fox');
const art = characterFromHash(hash);
const sameArt = await characterFromText('Rapid Fox');
// art: { hash, width, height, traits, layers: { background, character, foreground } }
```

Call cards seed this generator with the session UUID, not changing titles.
The service exposes `GET /api/character/parts`, `GET /api/character?text=...`,
`GET /api/character?hash=...`, and same-origin `POST /api/character` with
`{text, overrides}` or `{hash, overrides}`. Overrides use singular keys
`body`, `background`, `face`, `accessory`, `decoration`, and `palette`;
values must come from the parts catalog. Text is limited to 4096 characters.
Invalid hashes, traits, and overrides return HTTP 400. Rendering is stateless,
needs no write token, and does not save your seed. The lab shows both local
JavaScript and HTTP usage.

## Resolve and archive calls

Right-click a character and choose **Move to Resolved** when it has the context
it needs. The character moves from **In the room** to **Out to play**. Right-click
it there to **Move to Archived**, or bring it back into the room. The **Archived**
view lets you find and restore archived calls. Keyboard users can open the same
menu with Shift+F10 or the context-menu key, navigate with arrow keys, and dismiss
it with Escape.

State is saved atomically in
`%USERPROFILE%\.copilot\critter-call\session-status.json` (or under `COPILOT_HOME`).
The versioned file tracks session IDs, states, titles, repositories, and change
timestamps, not copies of transcripts. Resolved and archived calls remain
available even after they leave the recent-twelve window; the room fills with
up to twelve remaining recent sessions. Moves survive page reloads and server
restarts. Demo moves stay in memory and do not modify this file.

These are **Critter Call organization states only**: resolving or archiving does
not stop an agent, archive the underlying Copilot session, or dismiss its pending
questions. Calls never move automatically just because an agent posts an update.

## What connects to Copilot

**Observation works immediately.** The server reads the current user's local
`session-store.db`, desktop `data.db` catalog, `open-sessions-state.json`, and
selected sessions' `events.jsonl`. Recent tab history is preferred, with saved
sessions filling empty seats. Archived/deleted sessions are excluded. Names and
avatars are deterministic; the session title and ID remain visible for mapping
back to Copilot. Updates and native `ask_user` requests raise hands.

The local files are an **internal, version-dependent adapter**, not a promise of
a supported Copilot tab API. They are opened read-only, never edited. A tab's
presence is not proof of a live process. The feed refreshes every two seconds,
does not query a model, and only reads the last 2 MiB of a log at first load,
then incremental appends. Extremely large individual events are skipped.
Missing history or schema changes are reported in the page.

**Two-way replies use the opt-in MCP bridge.** Arbitrarily injecting text into
another running Copilot UI is not implemented. To connect:

1. Click **Connect agents** and copy the generated absolute-path configuration.
2. Merge its `critter-call` server entry into the MCP settings used by your
   Copilot app/CLI. Keep all existing servers. In CLI use `/mcp`, and reload
   tools/reopen the intended sessions as needed.
3. Copy the instruction from the setup dialog to each participating agent.
   It should call `raise_hand` with its current session UUID, message, and
   `kind` (`question`, `context`, or `update`).
4. For questions/context, the agent calls `get_reply` with the returned
   `requestId`. Each call waits up to 25 seconds and then reports `pending`,
   `answered`, or `dismissed`. Pending is not an answer; avoid busy-polling.

Subagents can include `agentName` to distinguish their requests within their
parent session tile. The central composer targets the **selected hand**, not
every agent. Multiple hands have separate targets and in-page drafts. Replies
are persisted atomically and cannot be overwritten; they survive restarts.
Closing the MCP client cancels its outstanding waits, not persisted hands.

History-only tiles offer **Copy for Copilot**, explicitly not an automatic
send. Native Copilot questions still require answering in Copilot unless the
agent itself uses the bridge. If a bridge hand belongs to a session outside
the latest twelve, the room reports it; open that session in Copilot to make it
recent enough to join.

## Privacy and boundaries

- HTTP binds only to `127.0.0.1`; host/origin checks and a per-process write
  token protect browser actions. No CORS, external scripts/fonts, or transcript
  uploads. Do not expose or reverse-proxy this server onto a network.
- The bridge only exchanges text. It never starts/resumes agents, executes
  commands, approves permissions, or changes Copilot trust settings.
- Pending hands and replies live in
  `%USERPROFILE%\.copilot\critter-call\bridge.db`, under the current user's
  existing profile permissions. Treat them as local conversation history;
  do not send credentials or permission approvals through it.
- `COPILOT_HOME` overrides the Copilot data root for both the web server and MCP
  process. Launch both with the same value if you customize it.
- Demo hands/replies are in a separate in-memory database. Real history is
  never used as demo data. Browser read markers persist in local storage;
  unsent drafts live only in the page and are lost on reload.

## Checks

```powershell
npm test
npm run test:browser
```

The tests use temporary synthetic catalogs and a real stdio MCP process. Browser
checks use installed Microsoft Edge in a separate headless profile and exercise
audio, mobile layout, demo isolation, and the complete
MCP hand -> browser reply -> MCP response path. Set `CRITTER_BROWSER` to another
Chromium executable if needed; no browser security flags are disabled.
