# Mycel: agent guide

Mycel is a shared project map. The person watches it in the browser ({{url}}) and sees your edits right away. Read this
page in full from the command line (`curl.exe -s {{url}}/agent` on Windows, `curl -s {{url}}/agent` on other systems)
or with the `guide` command below, not from a retelling.

Mycel has no chat: the person talks to you in your own window (Claude Code, Codex), and you reply there. Mycel is the
map you both see, plus the person's buttons on it: "Finish edits", and "Accept" and "Reject" on your proposal.
{{remote}}
Mycel command:
- PowerShell: `& {{command}} <command>`
- bash: `{{command}} <command>`

Below, `mycel` means this command. Run it from the root of the project you are working on. Claude Code signs as claude
by itself; another agent adds `--actor <name>`. In a sandbox without network, run Mycel commands with network permission.

The Mycel plugin is required; it is the first step. The person who runs Mycel works with agents only through it: the
plugin gives the `mycel_*` tools (MCP), labels on the map the blocks of the files you edit, reminds you at the end of a
reply to update their descriptions, and gives an overview of the map at the start of every session.
- If you have `mycel_*` tools, the plugin is installed. Use them instead of the command: `mycel_context` instead of
  `mycel context`, batches for `mycel_apply`, `mycel_build`, `mycel_propose` as an object, without files.
- If you do not have them and you are Claude Code: run `mycel plugin --install` (it connects the plugin and removes a
  separately connected mycel MCP server; safe to repeat) and tell the person to start a new session: the tools and hooks
  appear in it. If the command did not find claude, it prints two `claude plugin …` commands: run them. Until the new
  session, work with the `mycel` command.
- Another agent uses the same Mycel MCP server: `mycel plugin --agent <name>` prints the entry and the settings file to
  add it to, next to the other servers (codex, cursor, antigravity, gemini, vscode, windsurf, cline, claude-desktop and
  local model clients: lmstudio, continue, goose, opencode, jan, openwebui); connect it and start a new session. For
  Codex and Cursor the entry includes the Mycel hooks as well. The others have no hooks: run `mycel watch` in the
  background in the project folder (changed files are marked by themselves), or call `mycel_touch` after editing files;
  before finishing work, update the block descriptions or call `mycel_fresh`.
- An agent without MCP only needs the `mycel` command: `mycel tools` prints the descriptions of all tools for function
  calling (OpenAI format), `mycel call <tool> '<json>'` calls one. Your own local model without a client (Ollama, LM
  Studio, llama.cpp): `mycel chat --model <name>`; Mycel gives it the tools, a short guide and reading of project files.

Connecting:
- `mycel init` from the project root. The root is the nearest folder with `.git` (in a git worktree, the main
  repository); if there is no `.git` anywhere above, the root is the folder the command runs from. If this folder is
  already connected, its project with its map is used; if you are in a subfolder of a connected project, that project;
  otherwise a new project appears, and the person sees it on the home page right away. Your own name:
  `--name 'Name'`; for an already connected folder `--name` renames the project, only at the person's request.
- `mycel projects` lists all projects. If your project is shown as "folder missing" (the folder was moved or renamed),
  connect it to the current folder: `mycel init --project <id>`.
- If a command says the project was deleted by the person, stop and do not connect it again until the person asks
  (`mycel init --new`).

Before a task:
- Read the map: `mycel context`. It has all blocks with full text and level, nesting (sub-maps), notes, links with
  their ids, what the person selected and which block they are working in. Only the meaning, without coordinates and
  sizes: `mycel context --brief`.
- If the person writes "do this" or "this block", look at `mycel selection`: what they selected on the map and which
  block they are working in, with full text.
- If Mycel is unavailable, say so; do not claim the map is up to date.

Language: write map content (block titles and texts, notes, link labels) in the language the person uses with you;
if unsure, in English.

Map levels follow nesting. Concept and Mechanics are read by a person who does not program: from them they understand
what is what and set tasks. Technical and Code are read by developers.
- Concept: blocks of the main map: what this part is and why the product's user needs it. A title of 1–3 simple
  words, a text of one short sentence. Good: title "Cart", text "The customer collects products before paying". Bad:
  title "CartService", text "`cart.ts` keeps items in Redis".
- Mechanics: the sub-map of a concept: how this part works, in steps and parts that make sense without programming.
  A title of 1–4 words, a text of one sentence, links labelled in simple words ("product", "total"). Good: "Customer
  adds a product" → "Cart counts the total". Bad: title "addItem and reducer", text "`useCart()` dispatches ADD_ITEM".
- Technical: the sub-map of a mechanics block: how it is built: components, files, libraries, services, settings,
  data. Files and libraries in `backticks`, 1–3 short sentences. Good: title "Cart storage", text "`cart/store.ts`
  keeps items in Redis by session id". Bad: a retelling of the mechanics without files.
- Code: the sub-map of a technical block: steps in the order they run. The title is an action ("Check stock"), the
  text names the function and file and the key parameters: `checkStock(sku, qty)` in `cart/stock.ts`. Bad: title
  "Step 2", text "Then the check is called".
- Concept and Mechanics have no code: no backticks, calls like `name()`, file names and paths, names like `BOT_TOKEN`,
  `handle_message`, `getResponse`, or jargon ("dispatcher", "polling", "callback", "API client"). Names an ordinary
  person knows (Telegram, OpenAI, PDF) are fine. Guideline: a title up to 30 characters, a text up to 120.
- Every mechanics block has a technical sub-map, at least a block with the files and components that do it. Code goes
  where there are several meaningful steps (the main flows); for a part made of one function, put the function and
  file in the text of the technical block.
- Write a problem twice: on Mechanics as a note in simple words ("If you send a photo, the bot stays silent"), on
  Technical or Code as a note with the cause (a photo has no `message.text`, and the command check fails).
- Name data types and structures in the labels of technical links or in a note. Tests: a "Checks" concept or notes on
  the blocks they test. Unrelated parts of the product: separate groups with a note.
- Link blocks of the same level: an arrow from one part to another, not to a block inside its sub-map, so the order
  is visible. Inside a sub-map, link its blocks to each other.

First map: if the map is empty, build the project map as you read, so the person sees it grow.
- Start with an overview: the file tree, README, manifests (package.json, pyproject.toml and so on), entry points. You
  do not need to read all the code in a row.
- As soon as the concepts are clear (usually 4–8), run `mycel build <file>` with them and the links between them.
- Then one concept at a time: read its code and, with one `mycel build <file>` with `"parent": "<concept id>"`, add its
  mechanics, technical blocks inside every mechanics block, and code steps inside the technical blocks of the main
  flows. Blocks place themselves, and neighbours move apart.
- Show the steps with `mycel doing` ("reading `bot/`", "building the Cart mechanics"), and at the end
  `mycel doing --done` and one sentence to the person about what was built.
- Expected cost: a project of 40 files takes about 200k tokens and 10 minutes.

Online shop concepts, then the Cart mechanics (the block id is made from the title: "Cart" → `cart`):

```json
{ "message": "Concepts", "blocks": [
    { "title": "Catalog", "text": "The customer picks products" },
    { "title": "Cart", "text": "The customer collects products before paying" },
    { "title": "Payment", "text": "The customer pays for the order" } ],
  "links": [ ["Catalog", "Cart", "product"], ["Cart", "Payment", "total"] ] }
```

```json
{ "message": "Cart mechanics", "parent": "cart", "blocks": [
    { "id": "add-product", "title": "Customer adds a product", "text": "The product goes into the cart from the catalog page",
      "blocks": [ { "title": "Add to cart button", "text": "`AddButton` in `ui/AddButton.tsx` sends the product to the server" } ] },
    { "id": "total", "title": "Cart counts the total", "text": "The total changes with every change to the cart",
      "notes": ["The promo code discount sometimes disappears"],
      "blocks": [ { "id": "recalc", "title": "Recalculation", "text": "`cart/total.ts` adds up items and discounts",
        "notes": ["A promo code entered before sign-in is lost: `applyPromo()` reads an empty session"],
        "blocks": [ { "id": "sum-items", "title": "Add up items", "text": "`sumItems(items)` in `cart/total.ts`" },
                    { "id": "discount", "title": "Apply discount", "text": "`applyPromo(total, code)` in `cart/promo.ts`" } ] } ] } ],
  "links": [ ["add-product", "total", "product"], ["sum-items", "discount", "total"] ] }
```

Block marks show what of the map is already in the code and tested:
- Dashed (`plan`): logic without finished code: a block that is not in the code yet or has not been tested after a
  change. Blocks the person creates on the map are plans right away. A green border (`passed`): the code is written and
  the tests passed; red (`failed`): the check failed; pulsing (`testing`): the check is running now. A block without a
  mark is as before, for example on a map of code that is already written.
- `mycel mark <id[,id…]> plan|testing|passed|failed|none`. The person watches the map change colour as the tests run,
  so: before a run, mark the blocks under test `testing`; run tests per block or small group (not one run of everything
  at the end), and right after each one mark the result, `passed` or `failed`. Code steps and the blocks above them
  (technical, mechanics, concept) go green when everything inside has passed. A failure goes red, with a note giving the
  cause on the Technical or Code level. A sub-map with something under test or red inside is shown the same way by
  itself.
- When you add a block for something that is not in the code yet, give it `"status": "plan"` (in build and in add-node).

Code and map, so the map does not go out of date:
- Give technical and code blocks their files and test command: in build and add-node, `"files": ["cart/total.ts",
  "cart/"]` (paths from the project root, a folder ends with `/`) and `"test": "npm test -- cart"`. Mycel runs a
  `node …` command with the same node it runs on itself.
- When you change files, their blocks are marked "possibly outdated" (with the Mycel plugin in Claude Code by itself,
  after every file edit; otherwise with `mycel touch <file…>`), and the person sees your name above the block. When you
  are done: if how it works has changed, update the text of these blocks (`apply`) and the mark is cleared; if the
  description is still right, confirm it: `mycel fresh <id[,id…]>`. Outdated blocks are listed in context.
- Checks: `mycel check [id[,id…]]` runs the `test` commands of the blocks and of everything nested in them, sets
  `testing` itself, then `passed` or `failed` for each command; the person sees the map change colour. The person can
  press "Check" on a block; it arrives in wait and changes: run check and report the result.
- When you take on blocks: `mycel doing '…' --on <id,…>`; the person and other agents see who is working on what. If
  another agent is already working on a block, the command says so: agree on it with the person.
- What changed in how the project works, by concept: `mycel review` (for the last day; `--hours N`,
  `--since <revision>`); at the end of a big piece of work, show the person the result this way. Where the gaps are:
  `mycel health`: failed, outdated, unchecked, plan, TODOs and things that look like keys in the blocks' files (only the
  file and line).
- An agent in a virtual machine (VMware and others) can work with this same map. `mycel remote on` opens access, with the person's consent; `mycel remote` prints the install command for the agent there (`curl -fsS http://<address>:4317/install.sh | sh`). That agent sets everything up itself and asks for access, and the person presses "Allow" in Mycel. Do not answer the request yourself: it is the person's decision.
- `mycel plugin` builds the Claude Code plugin (MCP, edit highlighting, a reminder to update the map, a map overview at
  the start of a session); the person installs it: suggest it if there is no plugin.

Proposal: do not write logic changes the person has not approved yet (a new branch, reworked mechanics, a different
order of steps) to the map right away; propose them instead: `mycel propose <file>`. The file is like build's
(`"parent"`, `"blocks"`, `"notes"`, `"links"`) and/or `"operations"` like apply's, plus `"title"`, the name of the
proposal:

```json
{ "title": "Promo codes in the cart", "parent": "cart",
  "blocks": [ { "id": "promo", "title": "Promo code", "text": "The customer enters a code and gets a discount" } ],
  "links": [ ["promo", "total", "discount"] ],
  "operations": [ { "type": "update-node", "id": "total", "patch": { "text": "The total includes the discount" } },
                  { "type": "delete-node", "id": "add-product" } ] }
```

- New items appear on the map dashed and highlighted, changed ones are highlighted, deletions are only marked;
  collapsed sub-maps with proposed items expand. In `context` such blocks show `proposed: add`, `change` or `remove`.
- Tell the person in one sentence what you propose and why. While the proposal is open, the person edits it on the map,
  and you edit it with the next `propose` (it extends the open one) or with `apply` on the proposed blocks.
- The person accepts or rejects it with the buttons; the decision arrives in `wait` and `changes` ("Accepted proposal"
  with their edits, or "Rejected proposal"). Accepted blocks are plans: if the person asked for the change itself,
  implement them in code, run the tests and mark the result (`mark`). What was rejected is removed from the map, and
  everything is back as it was.

Focus: if the person is working on one block, context and changes have the line "The person is focused on block …".
Then read only that block: `mycel context --focus <id>` gives the block with everything nested and its links to the
rest of the map; work within it.

While you work:
- Keep track of the person's actions in Mycel and of map edits. If you can run background tasks (Claude Code), keep
  `mycel wait` running in the background (in MCP, `mycel_wait`: Claude Code moves a long call into the background by
  itself): when the person finishes edits, decides on your proposal or someone changes the map's content, the wait ends
  and sends it; take it into account and start it again. Otherwise call `mycel changes` at the start of every step.
- Changes come with the current text of blocks; your own edits are not in them. Moves and size changes do not wake the
  wait; they come with the next edit.
- The person edits the map in batches: from their first edit they have the "Finish edits" button at the bottom, and
  until they press it, `wait` does not wake on their edits, and `context` and `changes` say "The person is editing the
  map right now". Do not respond to these edits and do not change what they are editing. The pressed button arrives as
  the line "Map edits finished" together with the changes: take them into account; if they contain a request (a new
  block, a note with a question), do it and briefly tell the person what you did.
- What you are doing now: `mycel doing 'reading `server.mjs`'` (with `--progress 40` if you know the share done); the
  person sees the line under the map. No more than once per step; at the end, `mycel doing --done`. With the Claude Code
  plugin (and the Codex hooks) the line follows your task list by itself: keep the list current and use `doing` for
  more detail.
- To show the person the block you are talking about: `mycel show <id>`; the map moves to it and selects it.
- Read the output of `wait`, `changes` and `build` in full, do not cut it (`head`, `Select-Object -First`): what was
  printed counts as read and will not come again.

Quotes: put the text for doing in single quotes; inside double quotes, PowerShell and bash break backticks. An
apostrophe inside is written `''` in PowerShell and `'\''` in bash. Write the files for build, apply and propose with
your file-writing tool (UTF-8), not with Set-Content or a pipe, in a temporary folder outside the project.

How to change the map:
- A structure: `mycel build <file>` with `{ "message", "parent" (block id, optional), "blocks": [ { "id", "title",
  "text", "color", "status", "files", "test", "blocks": [ … ], "notes": [ "text" ] } ], "notes": [ … ], "links":
  [ ["from", "to", "label"] ] }`. The id can be left out: it is made from the title; a link refers to an id or an unambiguous title.
  Coordinates are not needed: blocks place themselves. If build was interrupted, repeat it with the same file: blocks,
  notes and links already written are skipped.
- Point edits: `mycel apply <file>` with `{ "message", "operations": [ … ] }` (or just an array of operations); the
  reason can be given with `-m`. Block and link ids come from context (for a link, after `· id:`). For example, into the
  cart mechanics above:

```json
{ "message": "Delivery in the cart", "operations": [
  { "type": "add-node", "node": { "id": "delivery", "parentId": "cart", "title": "Choosing delivery", "text": "The customer picks a courier or pickup" } },
  { "type": "add-node", "node": { "id": "delivery-form", "parentId": "delivery", "title": "Delivery form", "text": "`ui/Delivery.tsx` and `api/delivery.ts`" } },
  { "type": "add-node", "node": { "type": "note", "parentId": "cart", "attachedTo": "delivery", "text": "Pickup is not available yet" } },
  { "type": "update-node", "id": "delivery", "patch": { "text": "Courier, pickup or post" } },
  { "type": "add-edge", "edge": { "id": "total-delivery", "source": "total", "target": "delivery", "label": "total" } },
  { "type": "update-edge", "id": "total-delivery", "patch": { "label": "order total" } } ] }
```

  `add-node` without `x` and `y` places the block itself, `parentId` puts it into a block's sub-map; a note is
  `"type": "note"`, attached to a block on its own level with `"attachedTo"`. `update-node` changes `title`, `text`,
  `color`, `status`, `files`, `test`, `parentId`, `attachedTo`, `collapsed`, `x`, `y`, `w`, `h` (`null` or empty clears `status`, `files`, `test`); `update-edge` changes `label`, `source`, `target`. Deleting: `[ { "type":
  "delete-edge", "id": "total-delivery" }, { "type": "delete-node", "id": "delivery" } ]`; a block is deleted with
  everything nested, its notes and links. `{ "type": "layout", "parentId": "cart" }` places a sub-map again (without
  `parentId`, the main map; with `"deep": true`, together with what is nested) and fits the sub-map's block to its
  content; manual placement is lost.
- Level check: build and apply write nothing if Concept or Mechanics contain code, files, names from code
  (`handle_message`, `message.text`, `CartService`), a title longer than 40 characters or a text longer than 200. It
  checks the titles and texts of blocks, notes and the labels of links between blocks of these levels, only what the
  batch adds or changes; plain text in any language passes. On a violation they print each one: move the technical
  details into a sub-map on the "Technical" level, keep simple words above, fix the file and repeat. The check does not
  catch jargon: watch for it yourself. `--no-check` only if the person asked for exactly such wording themselves.
- Writes go only on top of the revision you read. If the map has changed in the meantime, the command shows the changes
  instead of writing: take them into account and repeat. Do not overwrite others' work.

Do not change files in the Mycel data folder directly. The full format of build and operations is in {{readme}}.
