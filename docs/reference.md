# Mycel: full reference

A short introduction and quick start are in the [README](../README.md) (in Russian: [README.ru.md](../README.ru.md)). This page covers everything in detail: the interface, agent commands, the HTTP API, storage and development.

A free product map: blocks with text, sticky notes, sub-maps inside blocks and links between blocks. Everything can be moved, resized and connected with the mouse. One local app keeps the maps of all your projects. AI agents (Claude Code, Codex and others) connect a project themselves, build its map while you watch, read the whole map and learn about your edits, through `mycel.mjs` or the HTTP API.

Idea and requirements: [CONCEPT.md](../CONCEPT.md). Implementation state and checks: [PROJECT_STATE.md](../PROJECT_STATE.md).

## Running

You need **Node.js 22+**. There are no external dependencies, no build step, no cloud and no AI provider keys; `npm install` is not needed.

Double-clicking **`Mycel.cmd`** (Windows) or **`Mycel.command`** (macOS; run `chmod +x Mycel.command` once) starts Mycel in the background and opens it in the browser: [http://127.0.0.1:4317](http://127.0.0.1:4317). If Mycel is already running, the page simply opens; if an older Mycel version is running with the same data (after the program was updated), it is restarted. Node.js is looked up on PATH, and on Windows also in the Codex runtime. From a terminal the same is `node mycel.mjs open`; to stop it, `node mycel.mjs stop`.

All app data lives next to the program, in `.mycel/` (excluded from Git, so `git pull` does not touch it): the project registry, their maps, events for agents (what the person did with Mycel's buttons) and agents' read marks. Mycel writes nothing into project folders.

Before version 0.15 the program was called "Kontur": `kontur.mjs`, `Kontur.cmd`, data in `.kontur/`, MCP server `kontur`. On the first start Mycel renames `.kontur/` to `.mycel/` (if a hub of the old version is running there, `Mycel.cmd` replaces it), and the old `KONTUR_*` variables are read if there are no `MYCEL_*` ones. The MCP server has to be connected again under the name `mycel` (see "MCP" below).

## Projects

The home page is the list of projects: name, folder, number of blocks and time of the last edit; a green dot means an agent is waiting for messages. A new project appears in the list as soon as an agent connects it; a click opens its map. The trash icon in a row deletes the project (only its map in Mycel, not the folder), and "Undo" in the notification cancels the deletion; deleted projects are kept in `.mycel/trash/` for 7 days.

At the top is the line "For your agent: http://127.0.0.1:4317/agent". A click copies the phrase for the agent: "Read the Mycel guide and follow it: curl.exe -s http://127.0.0.1:4317/agent". Paste it into the agent's window in the project folder (Claude Code, Codex): the agent connects the project (`mycel init`), or, if the folder is already connected, continues working with its map. You talk to the agent in its own window: Mycel has no chat. The agent builds an empty map as it reads the code: first the concepts, then the mechanics of each with the technical and code levels inside, and on the canvas you see blocks, blocks inside blocks and links appear. As long as you have not moved the map, the view follows new blocks by itself; any move of your own turns this off, and "Show all" turns it back on.

Inside a project, "‹ name" in the bottom bar goes back to the list.

## Working with the map

- **Creating**: right-click on empty space, then "Block" or "Note". You can type right away: Enter moves from the title to the text, Ctrl/⌘ + Enter, Esc or a click elsewhere finishes input. An empty block or note disappears.
- **Sub-maps**: right-click on a block, then "Block inside" or "Note inside". The block becomes a container and immediately gets a roomy field: its title and text at the top, the sub-map canvas below. Blocks inside move freely; to move a block into a sub-map, drag it onto the sub-map's field (it is highlighted), and to take it out, drop it outside the field. If the content gets crowded, the field grows and remembers its size; the corner resizes it, but not below the content. The chevron in the corner or the "Collapse sub-map" menu item turns it into a compact card with the number of blocks and notes inside, and a click on that label expands it again. Right-clicking the sub-map field creates a node right there. Links connect blocks on any level; nesting goes up to 8 levels.
- **Notes**: right-click on a block, then "Note on block". It is a sticker that moves with the block and is deleted with it. A note can be moved anywhere: it stays attached, and a dashed thread is shown between it and the block. Drag a note onto another block on the same level to re-attach it: a main-map note dropped on a sub-map attaches to the container itself, not to a nested block. A note dropped on a block lands next to it, to the right or below, whichever is closer, rather than on its text. "Detach from block" is in the note's menu.
- **Editing**: the pencil in the top right corner of a block (visible on hover and on the selected block) opens editing of the title and text right away, for a block with a sub-map too, without diving in. Double-clicking a block without a sub-map, or a note, edits the title or text under the pointer. The title and text of a block with a sub-map can also be edited with Enter on the selected block or with "Edit" in its menu. Dragging moves; the bottom right corner resizes.
- **Marks** are shown only with the border; the block is not filled: without finished code, dashed (a new block created on the map is like this right away); testing, the border pulses; passed, green; failed, red. A sub-map with something inside being tested or failed is shown the same way. The agent sets marks (`mark`) as tests run; every change arrives at once and flashes a ring (for a block in a collapsed sub-map, on that sub-map's card).
- **Agent proposal**: new things are dashed and highlighted, changed things are highlighted, things to be deleted are faded and struck through; collapsed sub-maps with proposed items are expanded, and the view moves to them. It can be edited as usual; at the bottom centre of the map are its title, "Reject" and "Accept". The decision goes to the agent together with the edits (in `wait` and `changes`) and is briefly confirmed on screen.
- **Diving in**: double-clicking a block with a sub-map opens it: the map shows only that block with its sub-map expanded, the sub-maps of nested blocks are collapsed (exactly one level below is visible), the path "Map › … › Block" is at the top, and the view moves smoothly to the block. Double-clicking a nested block with a sub-map goes one level deeper. To go up one level: Esc (if nothing is selected or being edited) or double-click on empty space; a path segment jumps straight there. Diving in is the same as focus (the agent sees where the person is), makes one History record and does not wake agents. "Open" in any block's menu opens it the same way: in a block without a sub-map, the next level is created with "Block inside".
- **Link**: drag from any edge of a block (it is highlighted on hover and the cursor becomes a crosshair), from the circle on the right edge, or with Alt held from anywhere on the block. A line with an arrow follows the cursor; over a block it settles the way the finished link will lie, and the block is highlighted. Release anywhere on another block: the link goes to the block under the cursor (of stacked blocks the top one, of nested blocks the deepest); the block you drag from does not get in the way, so you can also link to a block it covers. A drop on an attached note links to that note's block, and right at a block's edge to that block; releasing on empty space creates nothing. Tab on the selected block creates a linked block to the right. Links connect only blocks.
- **Selection**: clicking a block shows a panel with colour and the "Link" and "Delete" buttons; right-click opens the menu of block actions. Delete removes the selection; deleting a block with its content and notes, deleting a note and deleting a link can be undone from the notification.
- **Links**: on hover the line is highlighted, a delete cross appears in its middle, and handles appear at its ends that can be dragged straight onto another block; on a labelled link the cross is above the label. Hovering a block highlights all its links. Clicking a link selects it: the label, direction change and delete controls appear. The link menu has "Move start to…" and "Move end to…" for moving an end with a click. Deleting a link can be undone from the notification. A link cannot loop back to its own block or duplicate an existing one.
- **Screen layout**: the map takes the full width with the control bar below it, as in n8n: the "Map" and "History" tabs, the level slider, the agent's dot and map download. Above the bar is what the agent is doing right now, when it reports it. If there is little room under the map, the bar wraps onto several lines.
- **Levels**: a slider in the bottom bar with four ticks (Concept, Mechanics, Technical, Code), with the name of the chosen level next to it. Click a tick, drag (the map changes when the slider is released) or use the arrow keys when it has focus. If sub-maps are collapsed unevenly and no level fits the map, the thumb is dim and has no name; a click on any tick evens the map out. Concept and Mechanics are read by a person who does not program: main-map blocks are the concept (what this part is and why it exists), their sub-maps are the mechanics (how it works, in steps that make sense without programming); short and without code. Sub-maps of mechanics are the technical level for developers: components, files, libraries, settings, data, technical risks. Sub-maps of the technical level are code: steps in the order they run, with functions and files in `backticks` (monospace). "Concept" collapses all sub-maps, "Mechanics" shows the sub-maps of the main map, "Technical" one level more, "Code" expands everything. When a sub-map expands, neighbours to the right and below move apart, and when it collapses, they come back; a block's notes move with it as a whole stack. How the map looks depends only on what is collapsed: changing the level, diving in and coming back out return everything to its previous place. If a collapsed card with its notes still lands on something (for example, a stack on the right lands on a note under the middle of a sub-map), whatever it landed on moves right or down and stays there. A sub-map that grew from an edit (a block inside it was dragged to the edge, "Block inside") also pushes its neighbours apart and keeps its notes close.
- **Agent**: Mycel has no chat; you talk to the agent in its own window (Claude Code, Codex). The dot in the control bar: green means the agent is waiting for your actions, yellow means it is working; its name is in the tooltip. Above the bar is what it is doing right now ("reading server.mjs", with a progress bar if the share done is known). When the agent shows a block, the map moves to it (into its sub-map) and selects it. The agent sees what you have selected on the map and which block you are working in, so "do this" makes sense to it.
- **Focus**: double-clicking a block with a sub-map or "Open" in the block menu (the same as diving in) is for working on one module or stage. Only that block with everything nested in it stays on the map; at the top are the path to it ("Map › … › Module", a click on a segment goes there) and the "Block inside" and "Note" actions. Levels switch within the module, and right-clicking empty space creates a node inside the module. The agent sees which block the person is focused on. Esc goes up one level (for a main-map block, it leaves focus), and ✕ and "Map" in the path leave at once. The module is fitted into the window together with its attached notes.
- **Task progress bar**: while the agent is running a task, a strip appears above the bottom bar with a segmented progress bar, the current step and a percentage; if the agent does not report a percentage, a glow runs along the bar. A finished task shows a full green bar for a few seconds.
- **Canvas**: dragging the background moves the map, the wheel scrolls, Ctrl/⌘ + wheel or a pinch zooms. The zoom buttons are at the bottom left; "Show all" fits the map into the window.
- **History**: author, time and reason of the last 200 changes. The button in the top right corner downloads the map with its history.

The colour theme follows the system setting. The canvas position and zoom are remembered in the browser.

The interface is in English; Russian can be chosen with the EN / RU switch (at the right of the home page header and of the map's bottom bar), and a browser set to Russian gets Russian until a choice is made. The choice is remembered in the browser; switching keeps the open map, view and edits. Everything agents read (command output, MCP tools, the agent guide, server messages) is in English only. The map itself is written by agents in the language the person uses with them: block titles and texts, notes, link labels, proposal titles, the line under the map and the reasons in history. The guide, the plugin skill, the MCP server instructions and the session-start overview all say so.

## Agents

An agent only needs the address **`http://127.0.0.1:4317/agent`**: it has the guide with a ready Mycel command for this computer (the full path to node and `mycel.mjs`, lines for PowerShell and bash). Without the server, `node mycel.mjs guide` prints the same guide. The guide text is [src/agent-guide.md](../src/agent-guide.md).

`mycel.mjs` is the command line for agents. It is run from the project folder: the project is found by the folder (the root is the nearest folder with `.git`; a subfolder of a connected project belongs to it; a git worktree belongs to the main repository's project; and a repository inside a connected folder gets its own project), and if Mycel is not running, the command starts it itself (output goes to `.mycel/server.log`). It remembers which revision each agent has read (Mycel stores the read mark), shows others' edits made since that read, and writes only on top of what was read: if the map has changed in the meantime, it prints the changes instead of writing.

```sh
node mycel.mjs init                    # connect the folder: the same project if already connected, otherwise a new one
node mycel.mjs projects                # all projects: id · name · folder ("folder missing" if it was moved)
node mycel.mjs init --project ural     # connect project ural to this folder (its folder was moved or renamed)
node mycel.mjs init --name 'Ural'      # rename the project of an already connected folder (id and map stay the same)
node mycel.mjs open                    # start Mycel if it is not running, and open it in the browser
node mycel.mjs stop                    # stop Mycel
node mycel.mjs context                 # the whole map in Markdown: blocks with full text and level, nesting, notes, links with ids; what the person selected and their new actions in Mycel
node mycel.mjs context --focus server  # only the block with everything nested and its links to the rest of the map
node mycel.mjs changes                 # what others changed since the last read
node mycel.mjs wait                    # waits for a person's action in Mycel or someone else's content edit, prints it and exits
node mycel.mjs build map.json          # a structure; without x and y the blocks are placed automatically; written in steps
node mycel.mjs propose plan.json       # a proposal to the person: like build and/or operations, "title"; the person decides
node mycel.mjs mark promo,total passed # mark: plan (dashed), testing (being checked), passed (green border), failed (red), none
node mycel.mjs apply ops.json          # a batch of operations; - instead of a file reads standard input
node mycel.mjs selection               # what the person selected on the map and which block they are working in, with full text
node mycel.mjs doing 'reading server.mjs' --progress 40  # what the agent is doing now: the line under the map; doing --done clears it
node mycel.mjs show total              # show the person a block: the map moves to it and selects it
node mycel.mjs check total             # run the check commands (test) of the block and everything nested: borders turn green and red as it goes
node mycel.mjs fresh total             # the block's description is still right after its files were edited: clear "possibly outdated"
node mycel.mjs touch cart/total.ts     # files the agent is changing (the Claude Code hook does the same): their blocks are "being edited"
node mycel.mjs review --hours 24       # what changed in how the project works, by concept, in simple words
node mycel.mjs health                  # failed, outdated, unchecked, plan, TODOs and things that look like keys in the blocks' files
node mycel.mjs overview                # a short overview of the map (the hook gives the same to the agent at session start)
node mycel.mjs plugin                  # build the Claude Code plugin for this computer
```

Put the text for `doing` in single quotes: inside double quotes, PowerShell and bash break backticks. The read mark is saved before printing, so truncated output (`| head`, `Select-Object -First`) does not lose it; still, the agent should read the output of `wait`, `changes` and `build` in full.

**Deleted project.** If the person deleted a project, commands answer `Project "X" was deleted by the person` and do not connect it again; a new project on the same folder only with `init --new`, at the person's request.

**Code and map.** A block can have `files` (paths from the project root; a folder ends with `/`) and `test`, a check command (`node …` is run with the same node as Mycel). When the agent changes a file (the Claude Code hook after an edit, or `touch`), the blocks of that file show its name on the map for 2 minutes and are marked "outdated?" until the agent describes them again (an edit of the title, text, files or check) or confirms the description (`fresh`); `context` lists them. `check` sets the blocks to `testing`, runs each command once from the project root and immediately marks its blocks `passed` or `failed`. In the menu of a block with a check command, the person has "Check": the `kind: 'check'` event wakes the agent. `doing --on <id,…>` shows which blocks the agent is working on; if another agent is already working on them, the command and the hook warn about it. `review` and the "What changed" summary at the top of History describe changes by concept; `health` and the "Health" mode in the control bar show failed, outdated, unchecked (has files, but no command and no "passed" mark), plan and risks: `TODO`, `FIXME`, `HACK`, `XXX` and lines that look like keys in the blocks' files; only the file and line number are printed, and `.env`, keys and certificates are not opened.

**The Claude Code plugin is required for agents in Claude Code.** The `/agent` guide requires it as the first step: `node mycel.mjs plugin --install` builds the plugin and connects it (`claude` from PATH, otherwise the one whose session ran the command, found by `CLAUDE_PID`; `--claude <path>` for your own), is safe to repeat and removes a separately connected `mycel` MCP server; the tools and hooks appear in a new session. Without `--install`, `node mycel.mjs plugin` only builds a local marketplace with the `mycel` plugin in `.mycel/plugin`: the MCP server, hooks and a skill with a short guide, all with full paths. Hooks: after `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, a `touch` of the file and a warning if another agent is working on the block; after a change of the agent's task list (`TodoWrite`, `TaskCreate`, `TaskUpdate`, `update_plan` of the Claude desktop app), the line under the map shows the current step and the share of finished steps, and without a task list it shows the files being edited (a line the agent set with `doing` less than 2 minutes ago is kept; a helper agent's list is ignored); at the end of a reply, a request to describe or confirm the blocks whose files the agent changed in this session (once in a row), and the line under the map goes away unless the task list still has open steps; at the start of a session, an overview of the map (concepts and mechanics one line each, marks, outdated items, up to 6000 characters) instead of reading all the code. The hook stays silent if Mycel is not running, is a different version, or the folder is not connected. The person connects the plugin: `claude plugin marketplace add <folder> --scope user` and `claude plugin install mycel@mycel-local --scope user` (a separately connected `mycel` MCP server is then best removed). For Codex, `plugin` prints lines for `~/.codex/config.toml`.

**Virtual machine.** Mycel runs on the main computer; the browser and agents in a virtual machine (VMware, VirtualBox, Hyper-V, WSL) reach it over the virtual machine network, and the agent there sets everything up itself. On the main computer, `node mycel.mjs remote on` opens access on the addresses of the virtual machine adapters (or `--address`); `remote` shows what is open, which machines have access and the install command; `remote revoke <id>` revokes a machine key; `remote off` closes access; the setting is in `.mycel/listen.json`. The agent in the virtual machine runs `curl -fsS http://<address>:4317/install.sh | sh`: the script installs Node.js 22+ if it is missing (the official build from nodejs.org, checked with SHA-256, into `~/.mycel-node`) and a copy of Mycel into `~/mycel` (`/download/mycel.tar.gz`), and asks for access (`join` without a key). It prints a four-digit code; on any Mycel page on the main computer a card appears with the same code and a project choice: the person compares the code and presses "Allow". The machine gets its own key (`.mycel/devices.json` keeps only its hash) and saves it with the address and project in its own `.mycel/remote.json`; from then on commands, MCP and the plugin work from the project folder there (files and checks are local), and `node mycel.mjs open` opens the browser with the key. The agent connects a folder of the virtual machine itself as usual, with `init` in its root: the project is created on the main computer marked with this machine (`machine` in the registry; the path is inside the virtual machine, and the main computer does not check it); the home page shows the path with 'on machine "…"', and commands run from that folder there find it themselves; from folders without a project, the project chosen at "Allow" is used. Folders of different machines and of the main computer do not overlap; checks and risk scans of a machine's project run only on that machine. Only a machine with its own key can create a project (not a manual `join` with the main computer's key). Machines with access are listed on the home page, and "Disconnect" revokes the key. On virtual network addresses, without a key only `/api/health` (without `data`), `/agent`, `/install.sh`, `/download/mycel.tar.gz` and the access request are open; answering a request, connecting a folder, stopping Mycel and opening access are only possible on the main computer; the main computer's token never goes over the network (`remote --key` prints it for a manual `join <address> <key>`). A request lives for 10 minutes, one per address, up to five in total. Windows Firewall must let node through, and a VPN must not take over the virtual machine network. Only local network addresses are allowed.

**Any agent and local models.** Everything the Claude Code plugin does is also available without it:
- `node mycel.mjs watch` watches the project folder: changed files are marked on the map by themselves (their blocks become "outdated?", with a name above them: `editor` or `--actor`), whoever edited them, any agent or a person in an editor. Dependencies, build output, `.git`, data and files with secrets are not watched.
- `node mycel.mjs hook --from codex|cursor` handles Codex hooks (`~/.codex/hooks.json`: edits through `apply_patch`, `Stop`, `SessionStart`) and Cursor hooks (`~/.cursor/hooks.json`: `afterFileEdit`, `stop`, `sessionStart`) with the same meaning as the plugin's; `plugin --agent codex|cursor` prints ready entries. Event shapes follow the agents' documentation and have not been tested live with them.
- `node mycel.mjs tools [--format openai|mcp]` prints the descriptions of all tools for function calling; `node mycel.mjs call <tool> '<json>'` (or `-` for JSON from standard input) calls one, as through MCP. This is how Mycel plugs into your own agent or framework without MCP.
- `node mycel.mjs chat [--model name] [--base address/v1] ['task']` is a built-in agent for a local model on a server with an OpenAI-compatible API and function calling: Ollama (default `http://127.0.0.1:11434/v1`), LM Studio (`http://localhost:1234/v1`), llama.cpp `llama-server`, vLLM; the key is `MYCEL_LLM_KEY`, the model is `MYCEL_LLM_MODEL` or the first one from `/models`. The model gets a short guide (`mycel guide --short`), an overview of the map, all Mycel tools (except the long wait) and reading of project files (`list_files`, `read_file`, `search_files`; `.env`, keys and binary files are not read); it does not change code. Its name on the map is `local-<model>`. After a reply there is one reminder to describe the blocks whose files were marked under its name. With a task text it is one turn; without it, a conversation.
- `plugin --agent` also prints entries for local model clients: `lmstudio`, `continue`, `goose`, `opencode`, `jan`, `openwebui` (through the `mcpo` proxy).

**No chat.** The person talks to the agent in the agent's window (Claude Code, Codex), and the agent replies there. Mycel tells the agent only what the person did on the map with buttons (finished edits, accepted or rejected a proposal) through `wait`, `changes` and `context` ("The person in Mycel"). The agent sees what the person has selected and which block they are working in through `context` and `selection`. The agent shows the person what it is doing right now (`doing`) and the block it is talking about (`show`).

**MCP.** `mcp.mjs` is an MCP server for agents (stdio, no dependencies): the tools `mycel_guide`, `mycel_projects`, `mycel_init`, `mycel_context`, `mycel_changes`, `mycel_wait`, `mycel_selection`, `mycel_apply`, `mycel_build`, `mycel_propose`, `mycel_mark`, `mycel_doing`, `mycel_show` are the same `mycel.mjs` commands, with batches passed as an object instead of files. The agent is named after the client (Claude Code is `claude`, Codex is `codex`) or by `MYCEL_ACTOR`; the project is found by the folder the agent runs in (`CLAUDE_PROJECT_DIR`) or by the `project` and `folder` parameters. `mycel_wait` waits up to 25 minutes by default: Claude Code moves a long call into the background by itself and reports when it has finished. In Claude Code the MCP server is connected only through the plugin (see "the Claude Code plugin"); a separate connection is not needed, as the tools would be duplicated. Other agents connect the same MCP server: `node mycel.mjs plugin --agent <name>` prints the entry and the settings file for `codex` (`~/.codex/config.toml` or `codex mcp add`), `cursor` (`~/.cursor/mcp.json`), `antigravity` (replaced Gemini CLI: `~/.gemini/config/mcp_config.json`), `gemini` (`~/.gemini/settings.json` or `gemini mcp add`), `vscode` (`.vscode/mcp.json`, key `servers`), `windsurf` (Devin Desktop: `~/.config/devin/mcp_config.json`), `cline`, `claude-desktop`; paths follow the agents' documentation as of 28.10.2026. These entries have no hooks: after editing files the agent calls `mycel_touch` (`mycel touch`), and before finishing work it updates the blocks or calls `mycel_fresh`.

**The person's edits.** The person's first write that changes the map's content (not collapsing, a level change or a move) starts the edits: "Finish edits" with the number of records appears at the bottom centre of the map. Until the button is pressed, their records since the edits started come through in `changes` (`held` says how many), but `wait` does not wake on them, and `context` and `changes` say "The person is editing the map right now". The button (`POST /api/p/<id>/edits`) writes a `kind: 'edits'` event with `edits: { since, until, count }`; it wakes the agent, and `wait` prints all edits since the start. Started edits are kept in the project's `edit.json` and survive a restart. Events are kept in `.mycel/projects/<id>/chat.json` (which also holds the old conversation of projects that had a chat), the last 500, and do not change the map's revision.

**Levels.** When building the map, the agent lays it out on four nesting levels. Concept (main-map blocks) and Mechanics (their sub-maps) are for a person who does not program: a title of 1–4 simple words, a text of one short sentence, links labelled in simple words, problems as notes in simple words. Technical (sub-maps of mechanics) is for developers: components, files and libraries in `backticks`, settings, data, technical risks as notes; every mechanics block has it. Code (sub-maps of the technical level and deeper) is steps in the order they run: the action in the title, the function and file in the text; it is built where there are several meaningful steps. In `context` every block shows its level, and every link its id (`· id: …`) for `update-edge` and `delete-edge`. On the code level, automatic placement puts steps top to bottom; above it, left to right.

**Level check.** Before writing, `build` and `apply` check what the batch adds or changes on the concept and mechanics levels: blocks and notes (a title no longer than 40 characters, a text no longer than 200) and the labels of links whose both ends are on these levels. Backticks, calls such as `name()` and `send(message)`, names of code and config files and paths (`UI/Button.tsx`), names like `BOT_TOKEN`, `handle_message`, `getResponse`, `message.text`, `JSON.parse`, and classes like `CartService`, `BotHandler` are violations; product names (Telegram, OpenAI, PDF, Node.js), website addresses (openai.com), a bot's name and Telegram commands (`@study_buddy_bot`, `/set_language`) are not. The check does not catch jargon ("dispatcher", "polling"); the agent keeps an eye on that. On a violation nothing is written: the command prints every violation (block, level, fragment) and where to move the details (into a sub-map, on the "Technical" level) and exits with code 1. `build` checks only what it will write, so repeating an interrupted `build` does not trip over what was already written. `apply` works out levels from the map the agent read; if it has already changed, it prints the changes right away. `--no-check` skips the check, only when the person asked for such wording themselves. Old content and the person's edits in the interface are not checked.

The Mycel address is `--url` or `MYCEL_URL`, by default `http://127.0.0.1:4317`; the data folder is `--data` or `MYCEL_DATA`, by default `.mycel` next to `mycel.mjs`; the project is `--project ID`, by default the project of the current folder. The agent's name is `--actor` or `MYCEL_ACTOR`; without them, `claude` in Claude Code, otherwise `agent`. The reason for a write is `-m`. `--no-start` means do not start Mycel if it is not running; `--no-check` means `build` and `apply` without the level check. Changes are printed as text: History records with author and time, then added and changed blocks in full in their current form, deleted items, links.

**Notifications.** `wait` holds a long request to the server and exits as soon as the person does something with Mycel's buttons (finishes edits, decides on a proposal) or anyone other than this agent changes the map's content: adds or deletes a block, note or link, changes a text, title, colour or label, moves a node into another sub-map or attaches a note. Moves, size changes and collapsing do not wake it: they accumulate and arrive with the next content edit; `wait --all` wakes on any edit. The person's edits wake it only as a whole, when they press "Finish edits". The agent's own writes do not wake it. In Claude Code the command runs in the background, and its end reaches the agent as a notification with the changes; after it the agent runs `wait` again. An agent without background tasks calls `changes` at the start of every step.

**A whole structure.** `build` takes a tree: blocks with nested `blocks` (sub-maps) and `notes` (notes on the block), free `notes` and `links`. `id` can be omitted: it is made from the title in Latin letters (Cyrillic titles are transliterated); a link refers to an `id` or an unambiguous title. `parent` builds the structure inside an existing block. `build` writes the structure in steps with short pauses (first the level of the structure itself, then the sub-maps) so the person sees the map grow; `--at-once` writes it as one record, with the same result. Blocks already written (same id or title on the same level), notes and links are skipped, so an interrupted `build` can simply be repeated. If the person edits the map between steps, `build` continues on top of their edits as long as they do not touch what is being built, and prints them right away; "Written, revisions …" lists only its own revisions.

```json
{
  "message": "Project map from the code",
  "blocks": [
    { "id": "server", "title": "Server", "text": "Stores maps and serves them", "color": "green",
      "blocks": [ { "id": "api", "title": "Requests", "text": "Accepts map edits",
                    "blocks": [ { "title": "HTTP API", "text": "`server.mjs`, routes `/api/p/<id>`" } ] },
                  { "id": "store", "title": "Storage", "text": "Saves the map to disk",
                    "blocks": [ { "title": "Writing to disk", "text": "`src/store.mjs` writes `graph.json` atomically" } ] } ],
      "notes": ["Check the limits"] },
    { "id": "ui", "title": "Interface", "color": "blue" }
  ],
  "links": [ ["ui", "server", "edits"], { "from": "api", "to": "store" } ]
}
```

The server places new blocks itself: on the main map to the right of the existing ones, in a sub-map below its content; a link's source is left of its target (a link to a block inside a sub-map counts as a link to the sub-map itself), the order within a column is chosen so links cross less, notes go to the right of their block, and a sub-map grows to fit its content and pushes its neighbours apart: those below move down, those to the right move right, exactly enough to avoid overlaps; a block's size is fitted to its text. Link parts of the same level: an arrow from "Interface" to "Server", not to a block inside it, so the diagram reads in order. The `layout` operation tidies a map that is already drawn.

## HTTP API

Base URL: `http://127.0.0.1:4317`. Responses are JSON, except the guide and the context (text) and the SSE event streams.

App and projects:

| Method | Path | Result |
|---|---|---|
| GET | `/agent` | The agent guide with this computer's Mycel command (text) |
| GET | `/api/health` | `{ ok, app: "mycel", version, data }`; from a virtual machine without a key, without `data` |
| GET, POST | `/api/remote` | Main computer only: `{ port, listening: [{ address, listening, error? }], interfaces: [{ name, address, vm }] }`; POST `{ addresses }` sets on which addresses of its own adapters to accept virtual machine requests (an empty list closes access) |
| GET | `/api/session` | Token, data folder, port, platform, for the interface and `mycel.mjs` |
| GET | `/api/projects` | All projects: `id`, `name`, `path`, `exists`, `createdAt`, `updatedAt`, `revision`, `blocks`, `notes`, `edges`, `agents`, and `error` if it failed to open |
| GET | `/api/projects?path=<folder>[&root=<root>]` | The project whose folder contains `path` (the nearest); with `root`, only inside it. 404 if the folder is not connected; a deleted project has `deleted` in the response |
| POST | `/api/projects` | `{ path, root?, name?, id?, move?, new? }` connects a folder: the same folder is the same project (`created: false`), a subfolder of a connected one is its project (`ancestor: true`), otherwise a new one (`created: true`). With `root` (the git repository root), folders above it, live or deleted, do not capture the repository. `id` moves the project to the new folder (`moved: true`) if the old one is gone or `move` is set. The folder of a deleted project gives 409 unless `new` is set |
| POST | `/api/projects/<id>/delete` | Move the project to the trash. While the folder is being moved (up to ~2 s), the project's routes answer 503 `{ retry: true }`; `{ deleted: true }` comes only after the move. If the folder is busy, 409, and the project keeps working |
| POST | `/api/projects/<id>/restore` | Restore from the trash |
| GET | `/api/events` | Home page SSE: `{ projects }` when the list changes, `{ project, revision }`, `{ project, chat }`, `{ project, presence }` |
| POST | `/api/stop` | Stop a Mycel started from the command line |

The map of one project is under `/api/p/<id>`:

| Method | Path | Result |
|---|---|---|
| GET | `/api/p/<id>` | `{ project }`; 404 with `deleted` if the project was deleted |
| GET | `/api/p/<id>/graph` | Nodes (blocks and notes) and links without history |
| GET | `/api/p/<id>/context[?focus=id][&brief=1]` | Markdown: blocks with text, level and nesting, notes, links with their ids; with `focus`, only the block with everything nested and its links to the rest of the map; with `brief`, without coordinates and sizes. If the person is in focus, a line about it at the start |
| POST | `/api/p/<id>/focus` | `{ id \| null }`: which block the person is working on now; agents see it in `context` and `changes` (`focus`) |
| GET | `/api/p/<id>/changes?since=N` | What changed after revision N: History records, added and changed items in full, deleted items. `exclude=<actor>` drops this author's edits, `wait=S` (up to 300 s) holds the request while there are no such edits, `content=1` waits only for content edits (`contentChanged`), `chat=M` adds the person's actions in Mycel after change M, which always wake. `edit` is the person's edits they have not finished yet (`{ since, at, count }` or `null`), and `held` is how many records in the response are among them; they do not wake |
| POST | `/api/p/<id>/changes` | An atomic batch of operations |
| GET | `/api/p/<id>/chat[?since=M]` | Events for agents, what the person did with Mycel's buttons (`kind: 'edits'`, `'proposal'`; for old projects also the old conversation): the last 200 or those changed after M, the number of the last change, and agents: whether an agent is waiting now and when it was last seen. It cannot be written to from outside |
| POST | `/api/p/<id>/activity` | What the agent is doing now, `{ actor, text \| null, progress?, blocks? }` (`blocks` are the blocks it is working on): the line under the map; `null` clears it, and a forgotten one fades after 15 minutes |
| POST | `/api/p/<id>/edits` | "Finish edits": `{ message }`, a `kind: 'edits'` event, or `null` if there were no edits |
| POST | `/api/p/<id>/proposal` | An agent proposal, `{ expectedRevision, actor, title, operations }`: the batch is applied to the map with `proposed` flags (`add`, `change`, `remove`; deletion is only flagged), a new block gets the `plan` mark, collapsed sub-maps with proposed items expand; the map gets `proposal` (title, who, when, the previous content of what changed). The next batch extends the open proposal, and `title` is then optional |
| POST | `/api/p/<id>/proposal/accept`, `/proposal/reject` | The person's decision: accept (items flagged for deletion are deleted, flags are cleared) or reject (added items are deleted, changed ones are restored). Also finishes the person's edits; `{ graph, message }`, where `message` is `kind: 'proposal'` with `proposal: { title, by, result, edits? }` |
| GET | `/api/p/<id>/review?hours=H` or `?since=REV` | Review on the map: `{ since, revision, entries, human, agents, from, groups: [{ id, title, items }], passed, failed, text }`, changes by concept, without moves and size changes |
| GET | `/api/p/<id>/code` | `{ stale: [{ id, name, files, by, at, session? }], risks, work: [{ actor, blocks, files, at }] }`: outdated blocks, risks, who is working on what |
| POST | `/api/p/<id>/touch` | `{ actor, files, session? }`: the agent is changing files (paths from the project root); their blocks become "being edited" and "possibly outdated"; returns `{ blocks, others }`, where `others` are blocks another agent is working on |
| POST | `/api/p/<id>/fresh` | `{ actor, ids \| null }`: the description is right, clear "possibly outdated" (`null` for all) |
| POST | `/api/p/<id>/risks` | `{ actor, blocks: { id: { todo, secrets } } }`: risks from `mycel health` (numbers only) |
| POST | `/api/p/<id>/check` | `{ ids }`: the person asks to check blocks; a `kind: 'check'` event wakes agents |
| POST | `/api/p/<id>/show` | `{ id, actor }`: show the person a block; open pages move to it and select it |
| GET, POST | `/api/p/<id>/selection` | What the person has selected on the map: the interface writes `{ id \| null }`, the agent reads `{ focus, selection }` |
| GET/POST | `/api/p/<id>/cursor` | What the agent has read: `?actor=A` → `{ revision, chat }`; POST `{ actor, revision?, chat? }` keeps the larger of the old and new values |
| GET | `/api/p/<id>/history` | The last 200 events, newest first; each has a `delta`: ids of added items, changed items with field names, and deleted items |
| GET | `/api/p/<id>/export` | The full current JSON |
| GET | `/api/p/<id>/events` | SSE: `{ revision, edit, agents, activity, work, code }` after changes, `show` with the block the agent asks to show, `{ deleted: true }` when the project is deleted |

POST requests need `Content-Type: application/json` and `Authorization: Bearer <token>`. The `X-Mycel-Actor: <name>` header marks an agent as connected to the project; `mycel.mjs` sets it itself. The token is in `.mycel/token`, persists between runs and must not get into Git.

The server listens only on `127.0.0.1` and checks Host, Origin and Fetch Metadata (`/agent` only Host: the guide can be opened from anywhere, and there is no token in it). This is a tool for a trusted local machine, with no isolation between operating system users.

### Model

Node: `id`, `type` (`block` or `note`), `parentId` (the level: `null` for the main map or the id of a container block), `attachedTo` (notes only: the id of the block on the same level the note is attached to, or `null`), `collapsed` (for a block with a sub-map: whether it is collapsed), `title` (up to 200 characters, not shown on notes), `text` (up to 20000), `x`, `y` (coordinates of the top left corner), `w`, `h` (120–20000 × 60–20000, with room for a large sub-map; by default 220 × 110 for a block and 160 × 120 for a note), `color` (`""`, `gray`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`; `yellow` by default for a note), `status` (blocks only, optional: `plan`, logic without finished code, dashed; `testing`, a check is running now, the border pulses; `passed`, code written and checked, green border; `failed`, the check failed, red), `proposed` (only in an open agent proposal: `add`, `change`, `remove`; set by the server).
Link: `id`, `source`, `target`, `label` (up to 200), `proposed` (as for a node). Links connect only blocks; between two blocks there can be only one link in each direction.
A map with an open agent proposal: `proposal` is `{ title, by, at, nodes, edges }`, where `nodes` and `edges` are the previous content of what the proposal changed.

Main-map node coordinates are world coordinates. For a nested node, `x` and `y` are measured from the top left corner of the sub-map field: the field lies inside the container frame (1 px), 12 px from the left and below a header that is 36 px high, or 75 px if the container has text. A container's `w` and `h` are the size of the expanded sub-map; if the content does not fit, it is wider or taller on screen. A collapsed sub-map is a card no wider than 280 px. While the pointer is over the field, the interface does not let a nested node be moved left of or above the field, but the API accepts negative coordinates.

When a block is moved through `update-node`, the server shifts its attached notes by the same distance; nested nodes move by themselves because their coordinates are relative. Deleting a block deletes everything nested, attached notes and links. A block cannot be inside itself.

### Changing the map

First read `/api/p/<id>/graph` and take `revision`, then send a batch to `POST /api/p/<id>/changes`:

```json
{
  "expectedRevision": 0,
  "actor": "coding-agent",
  "message": "Added the delivery scenario",
  "operations": [
    { "type": "add-node", "node": { "id": "delivery", "title": "Delivery", "text": "Address → method → time", "x": 700, "y": 0 } },
    { "type": "add-node", "node": { "id": "courier", "title": "Courier", "x": 1040, "y": 0 } },
    { "type": "add-edge", "edge": { "source": "delivery", "target": "courier", "label": "address" } },
    { "type": "add-node", "node": { "type": "note", "attachedTo": "courier", "text": "Clarify the delivery zones", "x": 1220, "y": -90 } },
    { "type": "add-node", "node": { "id": "courier-slot", "parentId": "courier", "title": "Time slot", "x": 0, "y": 0 } }
  ]
}
```

A successful request returns the new graph and increases the revision by one. An error in any operation rejects the whole batch. Node `id`s must be free. The level check is done by `mycel.mjs`, not by the server: direct API requests and edits in the interface are not checked.

Operations:

- `add-node` with `node`; without `id` the server creates a UUID, without `type` a block. A nested node: the `parentId` of an existing block. A note: `"type": "note"`, optionally `attachedTo` a block on the same level. Without `x` and `y` the node is placed automatically after the whole batch, and without `w` and `h` its size is fitted to the text.
- `update-node` with `id` and `patch`: `title`, `text`, `x`, `y`, `w`, `h`, `color`, `parentId`, `attachedTo`, `collapsed`, `status` (`null` clears the mark). Attached notes follow the block with the same offset, including when `parentId` changes.
- `delete-node` with `id`: deletes the node, its notes and links.
- `add-edge` with `edge`: `source`, `target`, optional `id`, `label`.
- `update-edge` with `id` and `patch`: `label`, `source`, `target`.
- `delete-edge` with the link's `id`.
- `layout` places a level again: without `parentId` the main map, with `parentId` the block's sub-map, and the block itself is fitted to its content; with `"deep": true` also everything inside sub-maps, which then shrink to their content. Manual placement of these nodes is replaced.

Limits: 2000 nodes (blocks and notes), 8000 links, 1000 operations per batch, 1 MB per request. `actor` is a name given by the client, not a verified identity.

On **409 Conflict**, read the map again and merge the changes. Do not replace current data with an old full block by just putting in the new revision.

An example client without `mycel.mjs` adds a block to a project's map; the hub places it to the right of the others:

```sh
node examples/agent-update.mjs http://127.0.0.1:4317 .mycel/token my-product "Delivery" "Courier or pickup" "Added the delivery block"
```

## Storage and updates

`.mycel/` next to the program:

```
projects.json, projects.backup.json   project registry: id, name, folder, date
projects/<id>/                        map (graph.json, graph.backup.json), events for agents (chat.json), started edits (edit.json), outdated blocks and risks (code.json), agents' read marks (agents/), project.json
trash/<id>/                           deleted projects, 7 days
token, server.lock, server.log        API token, single-process lock, output of Mycel running in the background
listen.json, devices.json              addresses for virtual machines (mycel remote) and machines with access (key hashes)
remote.json                           in the Mycel copy inside a virtual machine: the main computer's address, key and project (mycel join)
plugin/                               the Claude Code plugin for this computer (mycel plugin)
```

The registry is written through a temporary file, keeping a copy of the previous one; if it is damaged, Mycel takes the copy, and without one it rebuilds the registry from `projects/*/project.json`. A project whose map could not be opened stays in the list with an error and is not overwritten.

`graph.json` holds the map and its history. Writing goes in order: temporary file → flush to disk → copy of the previous version to `graph.backup.json` → atomic rename.

Maps of earlier versions (nested blocks with essence, logic, criteria and questions fields) are converted to the free format the first time they are opened: nesting becomes parent → child links, the fields are gathered into the block's text, and the blocks are arranged as a tree from left to right. The original file is kept as `graph.v1.backup.json` or `graph.v2.backup.json`. Running again does not repeat the migration.

Damaged JSON is not overwritten. To recover, stop the server, save the damaged file separately and restore `graph.json` from the backup or from previously exported JSON.

`server.lock` prevents two Mycel instances from using one data folder. A lock left by a process that crashed is removed by itself on the next start.

## Development

```sh
node --test test/*.test.mjs
```

`test/app.test.mjs` covers the model and the hub: atomicity and validation, the level check (what counts as code and what as plain text), sub-maps, notes, links, History texts, automatic placement, changes for agents and waiting, no chat: the "what the agent is doing" line, showing a block and the person's selection; the person's edits before "Finish edits" (including after a restart), agent proposals, concurrent writes, restart and locking, migration of old maps, API protection, the context (four levels, link ids) and SSE, the project registry (connecting by folder, subfolders, trash and restore, registry recovery, a project with an error), agents' read marks, a batch with a nesting cycle and a deletion inside it (400, not a hang). `test/layout.test.mjs` covers pushing neighbours apart during step-by-step building: notes on growing blocks, tall notes, collapsed and expanded sub-maps, exact return after collapsing, random agent and human maps under levels, chevrons and diving in (no new overlaps, the order of operations does not matter, the view depends only on what is collapsed), a sub-map with notes on all sides, a stack of notes taller than the block, a note under a sub-map next to a stack, a block under a sub-map with notes below and to the left of it, notes and blocks under a wide sub-map, a sub-map growing from a person's edit and a note dropped on a block, collapsing speed on a large map and on a stack of 1990 notes, random builds without overlaps, level direction (top to bottom only for code), a sub-map larger than 2000 px. `test/cli.test.mjs` covers `mycel.mjs`: connecting, finding the project by folder, git worktrees and submodules, a deleted project, step-by-step `build` against `--at-once`, repeating an interrupted `build`, the person's edits between steps, `build` and `apply` refusing on level violations and `--no-check`, truncated output, `--file`, the person's actions in `context`, the person's edits before "Finish edits" in `changes` and `wait`, `doing`, `show` and `selection`, `propose` and `mark`, starting in the background, replacing an old version and stopping. `test/ui.test.mjs` covers the interface in headless Chrome (path from `MYCEL_CHROME` or the standard install; without Chrome the tests are skipped): clicks on the list and the map while an agent is writing, list updates with several agents, an empty canvas without hints, agent edits while the person is writing, diving in with a double-click (one quiet record, the path grows, Esc goes up), going up by double-clicking empty space and path segments, editing a block without a sub-map and a note by double-click, and a container with Enter, "Open" in the menu and "Block inside" on a leaf, four level buttons and the dive level in the switch, "Finish edits" at the bottom centre of the map, the pencil in the corner of a block, agent proposals (highlight, dashes, "Reject" and "Accept") and mark colours, no chat: the agent's dot and the "what the agent is doing" line, the agent showing a block, the person's selection. `test/mcp.test.mjs` covers the MCP server as a separate process, the way Claude Code runs it: handshake, tool list, batches as objects, a level check error as a tool error, the agent's name from the client, waiting for the person's decision. The tests use temporary folders and free ports and do not touch the real `.mycel/`.

`server.mjs` is HTTP and routing; `src/hub.mjs` is the registry, trash and projects in one process; `mycel.mjs` is the command line for agents; `mcp.mjs` is the MCP server with the same commands; `src/agent-guide.md` and `src/guide.mjs` are the agent guide; `src/paths.mjs` is project folders; `src/chat.mjs` is events for agents (what the person did with Mycel's buttons); `src/model.mjs` is the model, operations and change deltas; `src/levels.mjs` is levels and their check before an agent's write; `src/layout.mjs` is automatic placement; `src/store.mjs` is map storage and migration; `src/seed.mjs` is the empty map; `public/` is the interface, with no build step. After interface changes, reload the page; after server changes, restart Mycel (`node mycel.mjs stop`, then `Mycel.cmd`).
