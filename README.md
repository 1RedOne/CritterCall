# Critter Call

A local, video-call-style companion for recent Copilot sessions and pinned calls. It displays sessions as character cards with conversations and raised hands. Critter Call is a visual companion; it does not use your camera or microphone.  Inspired by `Agent Standup` and native for Copilot.

<img width="2438" height="1214" alt="image" src="https://github.com/user-attachments/assets/094fe3a5-70c4-473b-b3f2-e7e989fca5d1" />

* View recent Copilot sessions from local Copilot data.
* Use an optional MCP bridge to let agents raise hands and receive replies.
* Start optional managed calls through the Copilot CLI.

## Quick start

Requires Node.js 24 or newer and a modern browser. No package installation or build step is needed.

```powershell
git clone https://github.com/1RedOne/CritterCall.git C:\\git\\critterCall
Set-Location C:\\git\\critterCall
npm start
```

Open **http://127.0.0.1:47821** in your browser.

To explore with fictional sessions without Copilot, run `npm run demo` and open the same address.

## Connect Copilot agents

Recent sessions can appear without MCP setup. To enable raised hands and replies:

1. In Critter Call, select **Connect agents** and copy the generated configuration.
2. Add its `critter-call` entry to your Copilot MCP settings, keeping your existing servers.
3. Reconnect the MCP server and give participating agents the instruction shown in Critter Call.

**New Call** and direct messaging also require the signed-in Copilot CLI and its ACP interface. See [INSTALL.md](INSTALL.md) for setup, controls, recovery, privacy, and troubleshooting details.

* Connecting existing or archived sessions *
Any session can be imported into CritterCall, simply open the Copilot session and instruct the agent to scan the new mcp and make use of the `raise-hands` feature

# What's coming?

Aiming to add support for ChatGPT / Codex and Claude as well.

## Privacy

The server listens only on `127.0.0.1`. Do not expose it through a tunnel, reverse proxy, public listener, or port-forwarding rule.

