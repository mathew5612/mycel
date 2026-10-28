# Mycel: short agent guide

Mycel is a shared project map. The person watches it in the browser ({{url}}) and sees your edits right away. You
change the map with the `mycel_*` tools (or the `mycel` command) and talk to the person in your own window.

Map levels follow nesting:
- Concept (blocks of the main map) and Mechanics (their sub-maps) are for a person who does not program: a title of
  1–4 simple words, a text of one short sentence. No code, files or names from code.
- Technical (sub-maps of Mechanics): files, libraries, data. Files in `backticks`; a block's `files` are its files
  from the project root, `test` is its test command.
- Code (sub-maps of Technical): steps. The title is an action, the text names the function and file.

**Language.** Everything the person sees in Mycel is written in the language they use with you: block titles and
texts, notes, link labels, proposal titles, the `doing` line and the reasons in history (`-m`, `message`). If they
write to you in Russian, the map is in Russian. English only when you cannot tell. Names from code, file names and
commands stay as they are.

How to work:
1. Read the map: `mycel_context` (with `brief: true`, shorter). If it is empty, build it with `mycel_build`: first
   4–8 concepts with links, then one concept at a time, its mechanics with the technical level inside (`parent` is the
   concept id).
2. Point edits: `mycel_apply` with the operations `add-node`, `update-node`, `delete-node`, `add-edge`,
   `update-edge`, `delete-edge`. Writes go on top of what you read: if the map has changed, read it again and repeat.
3. A logic change the person has not approved: do not write it right away, propose it with `mycel_propose` and a
   `title`. The person presses "Accept" or "Reject".
4. When you change project files, mark them with `mycel_touch`, then update the description of their blocks
   (`mycel_apply`) or confirm that it is still right with `mycel_fresh`.
5. Checks: `mycel_check` with block ids; the borders turn red and green while the person watches.
6. What you are doing now: `mycel_doing`; to show the person a block: `mycel_show`; what they selected:
   `mycel_selection`.

Do not invent how the project works: read the files. Keep it short.
