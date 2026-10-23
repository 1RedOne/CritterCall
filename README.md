# Critter Call

A local video-call-style companion for your **recent Copilot tab sessions and
pinned calls**. Each session gets a stable quirky name and a layered blob character,
raised hands, and a private conversation pane. This is a developer tool, not
part of the Guest Configuration services or their deployment.

## Run

For step-by-step setup, MCP configuration, and local control unlocking, see
[Installing Critter Call](INSTALL.md).

Requires **Node.js 24 or newer** and a modern browser. No package installation,
build step, camera, or microphone is needed. Managed calls additionally require
an installed, signed-in Copilot CLI and the local control unlock described below.

```powershell
cd C:\git\critterCall
npm start
```

Open **http://127.0.0.1:47821**. Use **Demo room** to try twelve fictional
characters, questions, and replies without contacting real agents. `npm run demo`
starts a demo-only server. Set `$env:PORT` to use a different port.

## Chat layout

Drag the divider beside the conversation pane to resize it on desktop.
Keyboard users can focus the divider and use Left/Right to grow/shrink chat,
or Home/End for its minimum/maximum width. Double-click the divider to reset
the width. Custom widths are saved in browser local storage and constrained to
the current window size.

Double-click an agent card or playground critter to open a larger chat view,
or choose **Expand chat** in the conversation header. **Back to room** or Escape
restores the room without losing the selected thread or unsent reply. The same
expanded view is available on mobile; the drag divider is desktop-only.
Playground activities pause while the room is hidden behind expanded chat.

## New calls and direct messages

**New call** creates a real session using the installed, signed-in Copilot CLI's
ACP stdio interface. No SDK installation is needed. CLI 1.0.101 has been checked
with create, initial prompt, queued follow-up, history listing, release, and
reopen in a fresh process. ACP is a preview interface; an incompatible or missing
runtime produces an error rather than falling back to editing Copilot databases.
Set `CRITTER_COPILOT` to the absolute path of a Copilot executable if it is not on
`PATH`. Calls use your Copilot account and can incur normal model usage.

The New Call and unlock dialogs can be dismissed with their close button,
Cancel, Escape, or a click outside the dialog. Once **Create call** has been
submitted, closing its dialog does not cancel the runtime request: creation
continues in the background and the resulting call is pinned in the room.
Reopening the dialog while creation is pending shows its progress without
submitting another request.

Agent execution requires a **local control key**, separate from the public
page's browser write token. After starting the server, open:

```powershell
Start-Process "$env:USERPROFILE\.copilot\critter-call\open-controls.html"
```

With `COPILOT_HOME` set, use that directory instead of `%USERPROFILE%\.copilot`.
Alternatively, click **Unlock controls** and paste the contents of the local
`critter-call\control-key` file. These files are not HTTP assets. The launcher
passes the key in a URL fragment, which the page immediately removes and keeps
in tab-scoped session storage. Keys rotate on every server restart. Do not share
the key or launcher file, commit them, or send them through the MCP bridge.
They inherit the current profile's filesystem protections; protect that profile.

Choose an absolute project folder and initial message. The optional label is
local to Critter Call; Copilot generates its own history title. A blank model
uses the CLI default. The new card is pinned and marked **Managed call**.
Responses arrive incrementally through the existing two-second feed. Long output
is capped at 120,000 characters per turn with a visible notice; the full runtime
history remains in Copilot. Imported calls are not taken over.

- **Send message** starts a new turn without a raised hand.
- **Queue message** durably saves a follow-up behind the active turn. There is
  only one active turn per call. Queued messages can be cancelled before dispatch.
- **Send reply** still targets a selected pending MCP hand, not a new turn.
- Runtime permission requests appear in their own panel showing the requested
  operation and runtime-provided **once-only** allow/deny options. Ordinary
  messages never approve an operation. No approval-all or trust-bypass flags are
  added. Closing the connection or an expired permission request cancels it.

After a server restart, queued messages stay saved but calls require an explicit
**Reconnect**. Confirm the session is not open/running elsewhere first. If a turn
was interrupted after dispatch, its delivery is **uncertain**: it is not replayed,
and the queue stays paused. Cancel unsent messages, **Release to Copilot**, and
review the persisted history there.

Use **Release to Copilot** on an idle call before reopening it in the Copilot app
or CLI. This closes Critter Call's runtime connection and makes the call
history-only. Reopen using the displayed session UUID, for example
`copilot --resume=<UUID>`. Saved ACP sessions are discoverable through Copilot's
session history API even before the catalog databases are indexed. Opening one
as a live app tab is not automated. Critter Call cannot detect every external
client, so do not concurrently open a managed session in another frontend.
Release is intentionally one-way in this version.

Managed calls, message queues, and bounded display transcripts live in
`critter-call\managed.db`. `managed.lock` prevents another Critter Call controller
from managing the same store concurrently. Demo mode never starts a runtime.

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

Raised hands have a bright orange border, pulsing glow, waving badge, and a
more energetic character bounce, including on the selected card. Reduced-motion
settings disable these animations while keeping the prominent colors and badge.

Right-click an agent card or playground critter for **Dismiss Hand**.
Dismissal settles the targeted MCP hand without answering it; other agents'
hands and your selected conversation stay unchanged. With multiple hands, the
menu names the selected hand (or the first pending one on another card).
History-only notifications are acknowledged in this browser, not answered in
Copilot. This never approves or denies a runtime permission request.

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

In **Out to play**, turn on the optional **Show Playground** pill to replace
the cards with an original pixel-art garden. Resolved critters use their existing
character artwork at a smaller scale, wander around the pond and cottage, and
stop for breaks. Encounters trigger a squish and a heart over both friends.
Hover or keyboard-focus a critter for its name, thread, repository, and latest
recorded agent update; select it to read the conversation. The recap is an
excerpt of existing history, not a generated summary or a new model request.
Right-click or Shift+F10 still opens the lifecycle menu, including **Pin**.
The toggle preference is saved locally. Roaming pauses outside the playground
or in a hidden tab, and reduced-motion preferences disable movement entirely.
The scenery is drawn locally; no reference-image artwork or logos are included.

The garden includes a **boat dock**, **swing**, **slide**, and **bubble stand**.
Critters occasionally choose an activity and walk to its waiting line. Each
activity serves one critter at a time in FIFO joining order. Boat passengers board at
the dock, take **1 to 30 random lake moves**, and then return directly to the dock
before disembarking and allowing the next passenger aboard. Swing and slide
rides finish automatically; bubble blowers use a fixed five-particle effect pool.
These are local visual activities, not agent tasks or model calls.

Equipment is drawn once, lazily on the first playground activation. A single
animation loop updates movement at up to 30 frames per second using translated
sprites and cached stage dimensions; there are no per-critter timers. Activity
progress, queues, and effects pause when Playground is disabled, another call
view is selected, or the tab is hidden. Reduced-motion preferences also pause
all equipment. Re-enabling resumes the same scene without catching up elapsed
background time. Reloading the page starts a fresh visual scene; no activity
state is written into Copilot history.

Right-click a character and choose **Move to Resolved** when it has the context
it needs. The character moves from **In the room** to **Out to play**. Right-click
it there to **Move to Archived**. From **Out to play** or **Archived**, right-click
and choose **Pin** to bring a call back into the room. Pinned calls stay visible
regardless of age until you resolve or archive them again. Previously restored
in-room calls are also treated as pinned. Keyboard users can open the same
menu with Shift+F10 or the context-menu key, navigate with arrow keys, and dismiss
it with Escape.

State is saved atomically in
`%USERPROFILE%\.copilot\critter-call\session-status.json` (or under `COPILOT_HOME`).
The versioned file tracks session IDs, states, titles, repositories, activity
and change timestamps, not copies of transcripts. Only unpinned threads with
activity **less than seven days ago** can enter the room automatically; threads
exactly a week old or older appear in **Archived**, even if their tab was reopened.
This uses the catalog's last-updated time, not the thread's creation time or
the time you moved it between views. Older resolved threads also appear in Archive.
Threads without a valid activity timestamp stay in Archive with a warning until
pinned. Catalog imports include old threads beyond the former 200-entry window.
Archived imports show metadata without reading their event logs; Pin loads their
history back into the room.

Resolved and archived calls remain available outside the recent-twelve window.
Pins take priority, then recent threads fill any remaining seats up to twelve.
If you pin more than twelve calls, all pins remain visible. Moves survive page reloads and server
restarts. Demo moves stay in memory and do not modify this file.

These are **Critter Call organization states only**: resolving or archiving does
not stop an agent, archive the underlying Copilot session, or dismiss its pending
questions. Explicitly archived calls stay archived until pinned; automatic
age-based placement is recalculated from catalog activity on each refresh.

## What connects to Copilot

**Observation works immediately.** The server reads the current user's local
`session-store.db`, desktop `data.db` catalog, `open-sessions-state.json`, and
selected sessions' `events.jsonl`. Recent tab history is preferred, with saved
sessions filling empty seats within the one-week limit. Sessions archived/deleted
in Copilot itself remain excluded. Names and
avatars are deterministic; the session title and ID remain visible for mapping
back to Copilot. Updates and native `ask_user` requests raise hands.

Cards and the conversation heading use the **Copilot session name** from
`session-state\<UUID>\workspace.yaml`. The critter nickname is a secondary badge
and remains the voice identity. Names update on refresh when renamed in Copilot.
If workspace metadata has no name, the desktop title or catalog summary is used;
invalid metadata is reported in the page rather than silently ignored.
Workspace names are parsed locally using the unmodified, vendored JS-YAML 4.1.1
distribution. Its MIT license and pinned source details are in `vendor\`.

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

Each agent has **one pending hand**, identified by its session UUID and optional
stable `agentName`. Repeating `raise_hand` updates that hand's message and kind
and returns the **same request ID**; it does not add hands or replay an alert.
Answer or dismiss it before raising a new hand. Native history messages also
count at most once for the parent agent, not once per message.

Subagents with different names can still raise independent hands within their
parent session tile. The central composer targets the **selected hand**, not
every agent. Different agents' hands have separate targets and in-page drafts.
For duplicate pending requests left by older versions, one reply/dismissal settles
all waiting IDs for that same agent, without discarding its history. Replies
are persisted atomically and cannot be overwritten; they survive restarts.
Closing the MCP client cancels its outstanding waits, not persisted hands.

History-only tiles offer **Copy for Copilot**, explicitly not an automatic
send. Native Copilot questions still require answering in Copilot unless the
agent itself uses the bridge. If a bridge hand belongs to a session outside
the room, the page reports it. Pin an archived call, or use Copilot to bring
a recent, unpinned session into the recent-twelve window.

## Privacy and boundaries

- HTTP binds only to `127.0.0.1`; host/origin checks and a per-process write
  token protect browser actions. No CORS, external scripts/fonts, or transcript
  uploads by the history viewer. Managed calls intentionally send prompts to
  Copilot, and agent tools can access resources under the runtime's policy.
  Do not expose or reverse-proxy this server onto a network.
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
MCP hand -> browser reply -> MCP response path, plus synthetic ACP creation,
permission denial, queued follow-up, direct messaging, and release. Unit tests
also cover restart recovery, idempotency, controller ownership, protocol failure,
and missing/forged control capabilities. These automated tests do not call a model.
Set `CRITTER_BROWSER` to another
Chromium executable if needed; no browser security flags are disabled.
