# roclaude

A safety layer for building Roblox games with Claude Code through **Roblox Studio's built-in MCP server**. Claude edits your open place directly; roclaude makes that safe: it audits your RemoteEvents, keeps undo copies of Claude's edits, protects Team Create collaborators' work, and asks you before destructive Luau runs.

Requires Claude Code 2.1.287 or later and Roblox Studio with the MCP server enabled.

## What it does

### Studio activity: see and replay every change

`/roclaude activity` (or **Activity** above the prompt) shows what Claude did in your place. A card says whether Claude is working or done and sums it up ("Claude edited 2 scripts, changed 1 object"). Below it, everything Claude touched is listed by service with a badge: **Read**, **Edited**, **Created** or **Changed**; rows in progress light up as `reading…` or `editing…`.

Click a row to see its change, or step through the changes in order with **Prev** and **Next**:

- **Scripts** show a red and green diff from before Claude's first edit to after its last.
- **Objects** Claude changed with Luau show each property before → after (`Anchored  false → true`, `Color  rgb(99, 68, 44) → rgb(255, 0, 0)`), or Created / Deleted. roclaude reads up to five objects' properties just before and after each `execute_luau` call; changes made through a local variable aren't seen.

Where the app can place a side pane, the view opens beside the conversation (the first time Claude touches Studio, and on `/roclaude activity`). Where it can't, `/roclaude activity` draws the same view as a live card in the chat. When a turn ends with changes, a note in the transcript lists them with Claude's own summary.

### `/roclaude remotes`: audit your whole game

It finds every `OnServerEvent` and `OnServerInvoke` handler in the open place and sorts each one:

| Status | Meaning |
| --- | --- |
| **UNCHECKED** | Uses client values without checking them. Exploiters can send anything. |
| admin-only | Checks who is calling first (`isAdmin(player)`, `player.UserId ~= ...`, group rank). |
| checked | Checks every client value (`typeof`, `tonumber`, ranges, lookups). |
| no args | Takes nothing from the client. |

Handlers inside third-party modules (admin kits like Kohl's Admin or Adonis, `Packages`) are listed separately, so your own code stands out. The results open in a pane with a button that asks Claude to fix the unchecked handlers.

### Team Create

- **No edits against a stale copy.** roclaude remembers what Claude last read of each script. If a collaborator changed the script since, Claude's `multi_edit` is refused, and Claude is told to read the script again and redo its edit on the current version, so it never overwrites their work. Claude's own edits don't count as changes.
- **Who's in the session.** Collaborators who join or leave the live editing session (as reported in Studio's Output) show in the band and in `/roclaude`. Destructive-Luau confirmations name them too.
- **Teammate-safe undo.** `/roclaude undo` refuses when the script changed after Claude's edit; `/roclaude undo force` overrides.

### Undo for Claude's edits

Before each `multi_edit`, roclaude reads the script and keeps a copy. `/roclaude undo` puts back the latest one, and a script Claude created is deleted. `/roclaude history` lists what Claude changed this session. Studio edits made through MCP have no git history, so this is your safety net. Up to 50 copies are kept per session.

### A confirmation before destructive Luau

When Claude wants to run `execute_luau` code that deletes instances (`:Destroy`, `:ClearAllChildren`), writes DataStores (`SetAsync`, `UpdateAsync`, `RemoveAsync`), kicks or bans players, overwrites `.Source`, or loads code by asset id, you're asked first, even if you've allowed the tool. Read-only code runs as usual.

### A review of every edit

What Claude writes through `multi_edit` is checked, and findings go back to Claude so it fixes them in the same turn:

- RemoteEvent handlers that use client values unchecked. Luau type annotations don't count, because exploiters can send any value.
- `wait`/`spawn`/`delay` instead of the `task` library, `game.Players` instead of `GetService`, lowercase `:connect`, `Instance.new` with a parent argument, and `LocalPlayer` in server scripts.

After Claude changes a script, it's reminded to playtest, read the Output and fix errors before telling you it's done. Claude also gets these conventions in the `multi_edit` tool's description, so it sees them exactly when it edits.

### The band

A band above the prompt shows the place, the Team Create collaborators, how many edits can be undone, the last playtest result and the last check, for example: `◆ test2 · 👥 alex_dev · 3 edit(s) undoable · playtest: clean · Shop clean`.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install roclaude --marketplace vinkdc/roclaude
```

Answer `y` to add the marketplace, then choose a scope.

To connect Claude Code to Studio, turn on **Assistant → … → Manage MCP Servers → Enable Studio as MCP server** in Roblox Studio, then:

```text
claude mcp add --scope user --transport stdio Roblox_Studio -- cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat
```

On macOS, use `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` as the command. roclaude recognizes any MCP server whose name contains "roclaude" or "studio".

## Commands

| Command | What it does |
| --- | --- |
| `/roclaude` | Studio, Team Create and playtest status, and the last check's findings |
| `/roclaude activity` | Shows what Claude touched and replays each change, in a side pane or as a card in the chat |
| `/roclaude remotes` | Audits every RemoteEvent and RemoteFunction handler, and opens the results in a pane |
| `/roclaude undo` | Restores the script from Claude's latest edit; `/roclaude undo force` restores it even if it changed since |
| `/roclaude history` | Lists Claude's Studio edits this session |
| `/roclaude hide` / `show` | Hides or shows the band |

## Footprint

roclaude only talks to the Roblox Studio MCP server. It reads no files, makes no network requests, runs no processes and makes no model calls.

| Access | Why |
| --- | --- |
| `tool.call` on the Studio server's tools | Lets each call run, then: reads `script_read` results to know what Claude saw; around `multi_edit`, refuses a stale edit, keeps undo copies and attaches findings; reads the studio name, errors and collaborators from `list_roblox_studios` and `get_console_output` results. |
| `tool.check` on `execute_luau` | Changes "allow" to "ask" for destructive code. It never allows anything that was going to be refused. |
| `tool.describe` on `multi_edit` | Appends the Roblox and Team Create notes to the tool's description. |
| `$.mcp.call` → `script_read` | Saves a script before and after Claude's `multi_edit`, and reads handler scripts for `/roclaude remotes`. |
| `$.mcp.call` → `list_roblox_studios`, `script_grep` | Only for `/roclaude remotes`: finds the open studio and the scripts that handle remotes. |
| `$.mcp.call` → `multi_edit`, `execute_luau` | Only when you run `/roclaude undo`: puts back the saved source, or deletes a script Claude created. |

Undo copies and audit results stay in the session's memory. Claude Code asks you once to allow the Studio tools roclaude calls itself.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
