# Sub-map review (version 0.6)

26 October 2026. A review of commit `4f3d8c8` in three areas: code and model, interaction and layout, texts and documentation. Every finding was checked by two independent agents: one reproduced the defect, the other judged whether it was worth fixing within the task "sub-maps with collapsing and proper layout". A finding counts as confirmed if both agreed.

The user stopped the review before checking was finished. All code findings and 14 of the 16 layout findings were checked; the text findings were not.

References of the form `file:line` point to the code in `4f3d8c8`.

## State on 27 October 2026 (version 0.6.1)

All 18 confirmed defects and both unchecked layout items are fixed; each was checked in the browser on a demo map with a second-level container, and the model with tests. The disputed item was decided by the user: the label counts notes too ("2 blocks, 1 note inside"). The text and documentation findings were checked against the code and all were fixed, except the item about rejecting a move of a block with notes: in 0.6.1 notes move with the block, there is no rejection any more, and the README describes this. No items are open.

Where the fix differs from the proposed one:

- 3: the gesture starts from the shown size, but the saved size may be smaller than the content: it sets how the collapsed sub-map looks. The lower bound is the header plus the "N blocks inside" label (header height + 32 px), so the collapsed view does not break, and shrinking an expanded sub-map makes the collapsed one compact.
- 5: the container header is a separate `.head` element spanning the full width and height of the header; an empty container can be grabbed by it too.
- 12: on each level, containers are drawn first, then blocks, then notes, so a block placed on a sub-map lies above its header and content after release too.
- 13: a link from a container to a block nested in it starts from the nearest of the left, right and bottom sides of the frame; the top side is not used so the line does not cross the header.
- 14: the margin around a nested block's edge is clipped by the sub-map's field. A drop on the header goes to the container at any zoom, while a drop in the field next to a nested block still goes to that block.
- 16 and 17: notes follow the block on any `update-node` with coordinates or level, including a move to another level.
- Negative coordinates of nested nodes: `validate` still accepts them so already saved maps are not rejected; the README and PROJECT_STATE now say the restriction applies when dragging.
- Deleting a block in History: `Deleted block "a" (nested nodes: 3, notes: 1)`: nested content and notes attached from outside are counted separately.

## Confirmed, high severity

1. **A nested container at the second level or deeper captures the pointer with its whole body.** Links inside it cannot be hovered or selected, and right-click and dragging on the field act as if on the header. Cause: the rule `.block.container .sub > .block { pointer-events: auto }` in `public/style.css:175` also matches nested containers and overrides `pointer-events: none`. Fix: narrow it to `.sub > .block:not(.container)`. Add a check of a link inside a second-level container to the scenario.

## Confirmed, medium severity

2. **The sub-map field background is drawn above links.** At the second level, links and note threads are barely visible, and the fill of nested containers is distorted (`public/style.css:174`). Fix: draw the backing with `.sub::before` and `z-index: -1`, with no background on `.sub` itself.
3. **The resize corner of a grown container does not follow the cursor.** The gesture starts from the saved `w/h` rather than the shown size; shrinking silently saves 120 × 60 and breaks the collapsed view (`public/app.js:613`, `:661`). Fix: start the gesture from `layoutSize(n)` and do not save a size smaller than the content.
4. **Editing a container without text: the text input lies under the sub-map field**, and the text being typed is not visible (`public/app.js:74`, `headerH` takes the text from the node, not from the editor). Fix: while the container is being edited, treat the header as full height and move the field.
5. **A container with no title and no text has nothing to grab**: it cannot be dragged, opened for editing or given a menu through the header (`public/style.css:163`, `:168`). Fix: make the whole header strip a grab area with a separate element, or show an "untitled" placeholder.
6. **"Note on block" on a nested block gets a negative `y`** and sticks out onto the container header (`public/app.js:371`). Fix: inside a sub-map, clamp coordinates at zero or place the note to the right of the block.
7. **Dragging a nested block to the edge of the field desynchronises its notes**: during the gesture the note moves without the limit, after release it jumps, and the server saves it with a negative coordinate (`public/app.js:654`). Fix: first limit the shift of the whole group (block and notes), then apply one delta to all of them.
8. **A collapsed container lets clicks through in the middle of the card**: right-click offers to create a block on the main map on top of it (`public/style.css:163`). Fix: `.block.container.collapsed { pointer-events: auto }`.
9. **The collapse chevron is drawn above notes and blocks** (`z-index: 1`, `public/style.css:176`). A note on a container lands on the chevron by default, and a click on the note collapses the container. Fix: remove `z-index` from the chevron and place a container's note away from it.
10. **After a sub-map is collapsed, the selection stays on a hidden block or link**: the panel stays, Delete deletes something invisible, Enter and Tab block live updates (`public/app.js:192`). Fix: in `renderMap`, clear the selection if the node or a link end is not visible.

## Confirmed, low severity

11. **A 1 px offset per nesting level**: `worldRect` does not account for the container frame, link ends do not reach deep blocks, and blocks stick out of the field by 2 px (`public/app.js:97`). Fix: account for the frame (`PAD + 1`, `headerH + 1`) or draw the frame as a shadow.
12. **A block dragged onto a container ends up between the container's background and its text**, and the labels overlap. Fix: raise the dragged block during the gesture, or keep the container's background and header in one layer.
13. **A "container → its own nested block" link starts from the far side of the frame and runs through the block** (`public/app.js:218`). Fix: for nested rectangles, start the link from the near side, or forbid such links.
14. **At 50 % zoom, dropping a link on a container's title picks its nested block** (`public/app.js:544`). Fix: look for an exact hit first and use the edge margin only if there is none.
15. **A save error on collapsing, colour change and menu items is not shown**, and the local state drifts from the server (`public/app.js:797`). Fix: `return await commit(...)`, and re-read the map on error.
16. **Model: `update-node` with the current `parentId` turns off the shift of attached notes** (`src/model.mjs:124`). Fix: skip the shift only on a real level change.
17. **Model: moving a block with attached notes to another level is rejected** with an error about the note (`src/model.mjs:46`). Fix: move the notes with the block by the same offset, or describe the requirement in the README.
18. **Model: `validate` crashes with a TypeError and answers 500 instead of 400** if an ancestor in the chain has a `parentId` that does not exist (`src/model.mjs:39`). Fix: first check all `parentId` references in a separate pass.

## Disputed

- **A collapsed container holding only notes says "0 blocks inside"** (`public/app.js:208`). The code review confirmed the defect; the layout reviewer doing the check rejected it, because the label matches the README. Proposal: count notes too ("1 note inside", "2 blocks, 1 note").

## Rejected

- **Performance on very large maps.** With 1700 nodes, dragging costs 60–76 ms per frame and redrawing 190–300 ms; with 500 nodes it is about 60 frames per second. Judged out of scope for the task. For the future: `id → node` and `parentId → children` indexes, a `worldRect` cache, redrawing only the affected links.

## Not checked: layout

- Hovering a nested block shows the port and resize corner on all outer containers (`public/style.css:186`). Proposal: show them only on the block directly under the pointer.
- In container edit mode, the input fields are 12 px wider than the container and the title runs under the chevron. Proposal: `width: auto` on the fields and right padding for the chevron.

## Not checked: texts and documentation

- **The batch example from the README fails on the starter map**: the ids `checkout` and `payment` are already taken (high). Replace the ids with free ones; name the repeated id in the validation error.
- CONCEPT: an outdated sentence says that dropping a link on empty space creates a block.
- README and PROJECT_STATE: "a starter map of four blocks" is outdated; it has blocks, a note, links and a sub-map.
- PROJECT_STATE: "only block deletion can be undone", while deleting a block, a note and a link can all be undone.
- History: re-attaching a note writes "Attached note", while the change summary says "Changed note" (`src/model.mjs:133`).
- README: a note can only be re-attached to a block on the same level; over a sub-map, a main-map note attaches to the container.
- `examples/agent-update.mjs` places a new block on top of a grown sub-map, while the README promises "to the right of the others".
- The `/api/context` context and the README describe inaccurately where nested node coordinates are measured from and the size of a block with a sub-map.
- PROJECT_STATE says a nested node cannot be moved left of or above the field, but the API accepts negative coordinates. Either check this in `validate`, or say that the restriction applies when dragging.
- The README does not say that when a block's `parentId` changes, the batch is rejected because of its attached notes.
- Model messages call any node a "block", including a note.
- "Deleted block … and nested content (N)" counts attached notes as nested.
- The node name in History is cut in the middle of a word with no ellipsis.
- Starter map texts: the text of the "Blocks" block is cut off, and "Sub-map" does not explain how to create one.
- README: "right-click opens the same menu", although the block menu differs from the panel.
- PROJECT_STATE: the "N blocks inside" label only expands the sub-map, it does not collapse it.
- PROJECT_STATE: outdated mentions of `parentId` on a note (since 0.6 it is `attachedTo`).
- README and the agent template: the API description has no notes or nesting.
- `/api/context`: the English word "Revision" in otherwise Russian text, "collapsed" instead of "sub-map collapsed", "Notes inside <id>" without the block title.
- AGENTS.md contrasts the free map with "levels", although since 0.6 "level" is a model term.
- The same Russian verb was used both for expanding a sub-map ("Expand") and for reversing a link ("Flip arrow"). Proposal: "Reverse direction".
