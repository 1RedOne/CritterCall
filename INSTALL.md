# Installing Critter Call

These instructions cover a local Windows installation using PowerShell.
Critter Call runs directly from source; there is no package installation or
build step.

## 1. Check prerequisites

- Node.js **24 or newer**, including npm.
- A modern browser. Automated browser checks use Microsoft Edge by default.
- GitHub Copilot CLI, installed and signed in, for real Copilot sessions.
  The demo does not need Copilot. Creating managed calls requires the CLI's
  ACP interface; CLI **1.0.101** has been verified with this project.

Check the tools from the terminal where you will start the server:

```powershell
node --version
npm --version
copilot --version
```

If Copilot is not signed in, start `copilot` and use `/login`.
Normal Copilot account access and model usage apply to managed calls.

## 2. Put the source in a permanent folder

Clone or copy this repository to a location such as `C:\git\critterCall`.
Use your actual checkout path in the commands below if it differs.

```powershell
Set-Location C:\git\critterCall
Test-Path .\server.mjs
Test-Path .\mcp.mjs
```

Both checks should return `True`. Keep the included `public` and `vendor`
directories; their assets and licenses are part of the application.
There is no need to run `npm install`.

## 3. Start the server

```powershell
Set-Location C:\git\critterCall
npm start
```

Leave this terminal running and open **http://127.0.0.1:47821/**.
Stop the server with Ctrl+C. This is a terminal application, not an installed
Windows service; start it again after signing out or restarting your computer.

For a demo-only server, stop the normal server and run:

```powershell
npm run demo
```

The demo uses fictional sessions and does not start agents. The normal server
also has a **Demo room** option.

The server binds only to `127.0.0.1`. Do not expose it through a tunnel,
reverse proxy, public listener, or port-forwarding rule.

## 4. Connect existing Copilot sessions to the MCP bridge

Recent local sessions can appear automatically without MCP setup. The bridge
adds raised hands and targeted replies; it does not take control of those
sessions.

1. In Critter Call, choose **Connect agents** and copy the generated MCP
   configuration. It contains the correct executable and absolute script path.
2. Merge the `critter-call` entry into your Copilot MCP configuration, keeping
   all existing servers. For the default CLI profile, the file is
   `%USERPROFILE%\.copilot\mcp-config.json`. You can manage MCP servers using
   `/mcp` inside Copilot.
3. Reload/reconnect the server through the MCP UI, or reopen the intended
   Copilot session, so it discovers the tools.
4. Copy the agent instruction from **Connect agents** into each participating
   session.

For reference, a configuration for the example checkout is:

```json
{
  "mcpServers": {
    "critter-call": {
      "command": "node",
      "args": [
        "--disable-warning=ExperimentalWarning",
        "C:\\git\\critterCall\\mcp.mjs"
      ],
      "tools": ["*"]
    }
  }
}
```

Prefer the generated configuration if `node` is not available on the MCP
client's `PATH`. Do not replace your entire configuration with this example.

Agents use `raise_hand` with their current session UUID, a message, and a
`kind` of `update`, `question`, or `context`. Subagents also supply a stable
`agentName`. Questions and context requests use `get_reply` with the returned
request ID; `pending` is not an answer. Never use the bridge for secrets or
permission approvals.

**Check the connection:** ask a participating agent to raise a hand with a
harmless question, answer the selected hand in Critter Call, and confirm the
agent receives it.

## 5. Unlock New Call and direct messaging

While the normal server is running, open its local control launcher:

```powershell
Start-Process "$env:USERPROFILE\.copilot\critter-call\open-controls.html"
```

Alternatively, choose **Unlock controls** in the page and paste the contents
of `%USERPROFILE%\.copilot\critter-call\control-key` into the password field.
Do not paste this key into chat, logs, source control, or an MCP request.

The launcher unlocks that browser tab. The key is removed from the URL fragment
and stored in tab-scoped session storage. It changes every time the server
restarts; reopen the current launcher to unlock again.

Choose **New Call**, enter an existing absolute project-folder path and an
initial message, and create the call. An optional label is local to Critter
Call; Copilot generates its own history title.

| Session type | Sending from Critter Call |
| --- | --- |
| Existing imported session | Reply to a selected MCP hand; otherwise copy the message for manual paste into Copilot. |
| Managed session created with New Call | Send a new message at any time; messages sent while busy queue behind the current turn. |

Reloading MCP does **not** convert an imported session into a managed call.
Runtime permission requests have separate once-only allow/deny controls;
ordinary chat messages never approve an operation.

Use **Release to Copilot** on an idle managed call before reopening it in
another Copilot frontend. Release makes the call history-only. After a server
restart, use **Reconnect** only if the session is not running elsewhere.
Interrupted, uncertain turns are never automatically replayed; inspect their
history before continuing. See [README.md](README.md) for queue and recovery
details.

## Local settings and data

By default, both the server and MCP bridge use `%USERPROFILE%\.copilot`.
Critter Call stores its own history, queues, lifecycle state, and local control
files in that profile's `critter-call` directory, outside the source checkout.
Protect this directory as conversation history and protect your profile's
filesystem permissions.

If you use `COPILOT_HOME`, start the server and configure the MCP process with
the **same value**. For example, set it in the server's PowerShell terminal:

```powershell
$env:COPILOT_HOME = 'C:\path\to\your\copilot-profile'
npm start
```

The MCP server configuration also needs the same environment setting; setting
it only in the server terminal does not update an already-running Copilot app.
Use that profile's `critter-call\open-controls.html` and `control-key` files
instead of the default paths above.

Other optional server settings:

```powershell
$env:PORT = '47821'
$env:CRITTER_COPILOT = 'C:\path\to\copilot.exe'
npm start
```

Only set `CRITTER_COPILOT` if the executable is not available on `PATH`.
Changing the port changes the browser address; the generated launcher follows
the selected port.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `node:sqlite` is unavailable | Check that the server and MCP configuration both use Node.js 24 or newer. |
| MCP exits with `MODULE_NOT_FOUND` | Check the absolute `mcp.mjs` path. After moving the checkout, copy fresh configuration from **Connect agents** and reconnect MCP. |
| Address already in use | An existing server may already own port 47821. Use it, stop it in its own terminal, or deliberately choose a different `PORT`. |
| No sessions appear | Confirm the Copilot profile and page warnings. Unpinned sessions at least seven days old appear in Archive; right-click **Pin** to restore one. |
| Composer says **Copy for Copilot** | The selected imported session has no pending MCP hand. This is expected; use **New Call** for managed direct messaging. |
| Controls are locked after a restart | Open the newly generated local launcher or use the current local key. Old keys are invalid. |
| New Call cannot start Copilot | Check CLI sign-in, executable availability, ACP compatibility, and that the project folder exists. Read the displayed error rather than changing approval or trust settings. |

## Optional development checks

From the checkout:

```powershell
npm test
npm run test:browser
```

Browser checks use an isolated headless Edge profile. Set `CRITTER_BROWSER`
to another compatible Chromium executable if needed. Automated tests use
synthetic agent runtimes and do not call a model.
