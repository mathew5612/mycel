// Mycel tools for agents: one list for the MCP server (mcp.mjs), for exporting descriptions to any model with function
// calling (mycel tools), for calling by name (mycel call) and for the built-in agent for local models (mycel chat). Each
// tool runs the same mycel.mjs command an agent would run from a terminal and returns its output: the logic, checks and
// texts for the agent stay in one place. The project is the one connected to the folder the agent runs in, or given explicitly: project, folder.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'mycel.mjs');
const text = description => ({ type: 'string', description });
const where = { project: text('project id from mycel_projects; by default the project of the folder the agent runs in'), folder: text('the project folder, if the agent does not run in it') };
const noCheck = { no_check: { type: 'boolean', description: 'skip the check of the Concept and Mechanics levels: only if the person asked for such text themselves' } };
const object = description => ({ type: 'object', description, additionalProperties: true });
const ids = description => ({ type: 'array', items: { type: 'string' }, description: `id: ${description}` });
// name, description, parameters, command arguments and (for batches) the JSON for its standard input.
export const tools = [
  ['mycel_guide', 'The Mycel guide for the agent: map levels, how to build, propose and mark tests. Read it once at the start of work.', { short: { type: 'boolean', description: 'the short one, for small models' } }, a => ['guide', ...(a.short ? ['--short'] : [])], null, false],
  ['mycel_projects', 'All Mycel projects: id · name · folder.', {}, () => ['projects'], null, false],
  ['mycel_init', 'Connect a project folder to Mycel (the same folder is the same project with its map).', { folder: text('the project folder; by default where the agent runs'), name: text('the project name') },
    a => ['init', ...(a.folder ? [a.folder] : []), ...(a.name ? ['--name', a.name] : [])], null, false],
  ['mycel_context', 'The whole map in Markdown: blocks with text and level, nesting, notes, links with ids; what the person selected and which block they work in; their new actions in Mycel. Remembers what was read: writes go only on top of it.',
    { focus: text('block id: only this block with everything nested'), brief: { type: 'boolean', description: 'without coordinates and sizes' } },
    a => ['context', ...(a.focus ? ['--focus', a.focus] : []), ...(a.brief ? ['--brief'] : [])]],
  ['mycel_changes', 'What others changed since the last read: map edits and the person\'s actions (finished edits, accepted or rejected a proposal).', {}, () => ['changes']],
  ['mycel_wait', 'Wait for a person\'s action in Mycel or someone else\'s content edit of the map, then return them. A long call: Claude Code moves it into the background itself and reports when it finishes. Call it again after each reply while you work with the person.',
    { timeout_seconds: { type: 'number', description: 'how long to wait, 1500 (25 minutes) by default, at most 1700' } },
    a => ['wait', '--timeout', String(Math.max(1, Math.min(1700, Math.round(a.timeout_seconds ?? 1500))))]],
  ['mycel_selection', 'What the person has selected on the map now and which block they work in, with full text. When the person writes "do this" or "this block", look here.', {}, () => ['selection']],
  ['mycel_apply', 'A batch of map operations (add-node, update-node, delete-node, add-edge, update-edge, delete-edge, layout); the format is in mycel_guide.',
    { message: text('the reason for the change'), operations: { type: 'array', items: { type: 'object' }, description: 'operations' }, ...noCheck },
    a => ['apply', '-', ...(a.message ? ['-m', a.message] : []), ...(a.no_check ? ['--no-check'] : [])], a => ({ operations: a.operations })],
  ['mycel_build', 'A whole structure: blocks with sub-maps, notes, links; without x and y everything is placed automatically and written in steps, so the person sees the map grow.',
    { structure: object('{ "message", "parent", "blocks": [{ "id", "title", "text", "status", "files", "test", "blocks", "notes" }], "notes", "links": [["from", "to", "label"]] }'), at_once: { type: 'boolean', description: 'one record, without steps' }, ...noCheck },
    a => ['build', '-', ...(a.at_once ? ['--at-once'] : []), ...(a.no_check ? ['--no-check'] : [])], a => a.structure],
  ['mycel_propose', 'Propose a logic change to the person: a structure as for mycel_build and/or "operations" as for mycel_apply, "title" is its name. New items appear dashed and highlighted, deletion is only flagged; the person accepts or rejects with buttons, and the decision comes in mycel_wait.',
    { proposal: object('{ "title", "parent", "blocks", "notes", "links", "operations" }'), ...noCheck },
    a => ['propose', '-', ...(a.no_check ? ['--no-check'] : [])], a => a.proposal],
  ['mycel_mark', 'Mark blocks: plan, logic without finished code (dashed); testing, a check is running now; passed, tests passed (green border); failed, they failed (red); none clears it. Mark each result at once: the person watches the map change colour.',
    { ids: ids('blocks'), status: { type: 'string', enum: ['plan', 'testing', 'passed', 'failed', 'none'] } },
    a => ['mark', (a.ids ?? []).join(','), a.status ?? '']],
  ['mycel_doing', 'What you are doing now ("reading server.mjs"): the line under the person\'s map; on is the ids of the blocks you are working on (the person and other agents see them). done: true clears it when you finish.',
    { text: text('what you are doing, briefly'), progress: { type: 'number', description: 'how much is done, 0–100' }, on: ids('blocks you are working on'), done: { type: 'boolean' } },
    a => a.done || !a.text ? ['doing', '--done'] : ['doing', a.text, ...(a.progress === undefined ? [] : ['--progress', String(a.progress)]), ...(a.on?.length ? ['--on', a.on.join(',')] : [])]],
  ['mycel_show', 'Show the person a block: the map moves to it and selects it. Use it instead of a reference in text.', { id: text('block id') }, a => ['show', a.id ?? '']],
  ['mycel_check', 'Run the check commands (the test field) of the blocks and everything nested in them, without ids of the whole map: borders turn green and red as it goes, and the person sees it. Returns the result and the tail of the output of failed commands.',
    { ids: ids('blocks to check'), timeout_seconds: { type: 'number', description: 'the limit per command, 600 by default' } },
    a => ['check', ...(a.ids?.length ? [a.ids.join(',')] : []), ...(a.timeout_seconds ? ['--timeout', String(a.timeout_seconds)] : [])]],
  ['mycel_touch', 'Files you have just changed (paths from the project root, or full paths): their blocks on the map get your name and are marked "possibly outdated". Call it after editing files if you have no Mycel hooks and mycel watch is not running.',
    { files: { type: 'array', items: { type: 'string' }, description: 'changed files' } }, a => ['touch', ...(a.files ?? [])]],
  ['mycel_fresh', 'The blocks\' description is still right after their files were edited: clear the "possibly outdated" flag. all: true clears it for all.',
    { ids: ids('blocks'), all: { type: 'boolean' } }, a => a.all ? ['fresh', '--all'] : ['fresh', (a.ids ?? []).join(',')]],
  ['mycel_review', 'Review on the map: what changed in how the project works, by concept, in simple words, over hours hours (24 by default) or after revision since.',
    { hours: { type: 'number' }, since: { type: 'number', description: 'revision' } },
    a => ['review', ...(a.since !== undefined ? ['--since', String(a.since)] : a.hours ? ['--hours', String(a.hours)] : [])]],
  ['mycel_health', 'Map health: failed and outdated blocks, unchecked blocks, plan, TODOs and things that look like keys in the blocks\' files (only file and line).',
    { no_scan: { type: 'boolean', description: 'without reading files' } }, a => ['health', ...(a.no_scan ? ['--no-scan'] : [])]],
  ['mycel_overview', 'A short overview of the map: concepts and mechanics one line each, marks, outdated items. Cheaper than the full mycel_context.', {}, () => ['overview']]
].map(([name, description, properties, args, input = null, scoped = true]) => ({ name, description, properties: scoped ? { ...properties, ...where } : properties, args, input, scoped }));

export const schema = tool => ({ type: 'object', properties: tool.properties });

// A mycel.mjs command on behalf of the agent; the batch JSON goes through standard input. cwd is the folder the agent works in.
export function runTool(tool, a, { cwd, actor, env = process.env }) {
  const args = [cli, ...tool.args(a), ...(tool.scoped && a.project ? ['--project', a.project] : [])];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: (tool.scoped && a.folder) || cwd, env: { ...env, MYCEL_ACTOR: actor }, windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', c => { out += c; });
    child.stderr.setEncoding('utf8').on('data', c => { err += c; });
    child.on('error', e => resolve({ code: 1, out: '', err: e.message }));
    child.on('close', code => resolve({ code, out: out.trimEnd(), err: err.trimEnd() }));
    child.stdin.on('error', () => {});
    child.stdin.end(tool.input ? JSON.stringify(tool.input(a)) : undefined);
  });
}
// The tool's answer for the model: wait with no events within the limit is not an error, the agent simply waits again.
export function toolResult(tool, { code, out, err }) {
  const quiet = tool.name === 'mycel_wait' && code === 2;
  return { text: quiet ? 'The person did nothing in Mycel, and the map was not changed. Call mycel_wait again if you are waiting for them.' : [out, err].filter(Boolean).join('\n') || 'Done.', error: code !== 0 && !quiet };
}
