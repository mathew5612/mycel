// The agent guide: the src/agent-guide.md template with the Mycel address and this computer's command. GET /agent serves
// it, and `mycel.mjs guide` prints the same without the server. The command always has the full path to node: the agent
// may not have node on PATH. Forward slashes work in PowerShell, bash and cmd alike.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The person is editing the map: the agent does not respond to these edits until "Map edits finished" comes. A line for
// context, changes and wait.
export const editingLine = edit => `The person is editing the map right now (since revision ${edit.since}, records: ${edit.count}) and has not pressed "Finish edits" yet: do not respond to these edits and do not change what they are editing; "Map edits finished" will come when they press it.`;
const slash = p => p.replace(/\\/g, '/');
// remote: 'served' means the guide is read from a virtual machine over the network (this computer's commands do not work
// there); 'joined' means it is printed by a Mycel copy in a virtual machine connected to the main computer (mycel join).
// short is the short guide for small models (src/agent-guide-short.md): only the essentials, without examples.
export async function renderGuide({ url, remote = null, short = false }) {
  if (short) return (await readFile(join(appRoot, 'src', 'agent-guide-short.md'), 'utf8')).replaceAll('{{url}}', new URL(url).origin);
  const { origin, port } = new URL(url);
  const local = !remote && port !== '4317';
  const command = remote === 'served' ? '"<path to node>" "<Mycel folder in this machine>/mycel.mjs"' : `"${slash(process.execPath)}" "${slash(join(appRoot, 'mycel.mjs'))}"${local ? ` --url ${origin}` : ''}`;
  const note = remote === 'served'
    ? `\nYou are in a virtual machine, and Mycel runs on the main computer (${origin}). Set everything up with one command: \`curl -fsS ${origin}/install.sh | sh\`: Node.js 22+ (if it is missing, into ~/.mycel-node), a Mycel copy in ~/mycel and an access request. The command prints a code: tell it to the person; they compare the code and press "Allow" in Mycel on the main computer. It waits up to 10 minutes for the answer: if you can, run it in the background. Create the project of your folder yourself (\`init\` in its root): it appears for the person marked with this machine; the person chooses a project of the main computer when allowing access, and another one is \`--project <id>\`. From then on the Mycel command is node and ~/mycel/mycel.mjs, and the installer prints the full paths; first of all, connect the plugin: \`node ~/mycel/mycel.mjs plugin --install\`.\n`
    : remote === 'joined' ? `\nThis Mycel copy is connected to Mycel on another machine (${origin}, \`mycel join\`): the map is there, the project files and checks are here. Connect a folder of this machine as usual (\`init\` in its root): the project appears for the person marked with this machine. Mycel can be started and stopped only there.\n` : '';
  const template = await readFile(join(appRoot, 'src', 'agent-guide.md'), 'utf8');
  return template.replaceAll('{{remote}}', note).replaceAll('{{url}}', origin).replaceAll('{{command}}', command).replaceAll('{{readme}}', slash(join(appRoot, 'docs', 'reference.md')));
}
