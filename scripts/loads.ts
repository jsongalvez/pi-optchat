// Lists what a profile's agents load into their system prompt, block by block, with each block's source and word count:
// the main agent, and a subagent started in a given directory. It reads the live files and builds the text with the
// functions the runtime hooks use (`src/system-text.ts`, Pi's resource loader and prompt builder), so it shows what the
// next turn or spawn gets. Not shown: tool declarations, and sections other extensions add (MCP's <mcp_servers>).
//
//   npm run loads -- [--profile NAME] [--cwd DIR] [--lead-cwd DIR] [--context files|none] [--full]
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DefaultResourceLoader, formatSkillsForPrompt, getAgentDir, SettingsManager, type Skill } from '@earendil-works/pi-coding-agent';
import { lastProfile, loadConfig, profilePath, profileRules, type PromptBlock } from '../src/profiles.ts';
import { leadPrompt, promptSections, subagentPrompt, type AgentPrompt } from '../src/system-text.ts';

// Pi's own builder is not exported; this is the file its sessions call.
const piDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { buildSystemPrompt } = await import(join(piDist, 'core', 'system-prompt.js')) as { buildSystemPrompt: (input: object) => string };

const { values } = parseArgs({ options: { profile: { type: 'string' }, cwd: { type: 'string' }, 'lead-cwd': { type: 'string' },
  context: { type: 'string', default: 'files' }, full: { type: 'boolean', default: false } } });
const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()));
const name = values.profile ?? lastProfile();
if (!name) throw new Error('No profile: pass --profile NAME.');
if (values.context !== 'files' && values.context !== 'none') throw new Error('--context is files or none.');
const dir = profilePath(name), config = loadConfig(dir), agentDir = getAgentDir();
const leadCwd = expand(values['lead-cwd'] ?? process.cwd()), childCwd = expand(values.cwd ?? leadCwd), context = values.context;

/** Pi's resources for an agent in `cwd`: the same loader options a subagent's session uses, minus extensions. */
async function resources(cwd: string, noContextFiles: boolean) {
  const settingsManager = SettingsManager.inMemory(SettingsManager.create(cwd, agentDir).getSettings());
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noPromptTemplates: true, noContextFiles, noExtensions: true });
  await loader.reload();
  return { contextFiles: loader.getAgentsFiles().agentsFiles, skills: loader.getSkills().skills, append: loader.getAppendSystemPrompt() };
}
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const skillsBlock = (skills: Skill[]): PromptBlock[] => skills.length
  ? [{ source: `skills index: ${skills.length} skills (${skills.map(skill => skill.name).join(', ')})`, text: formatSkillsForPrompt(skills, 'read') }] : [];

async function show(title: string, cwd: string, noContextFiles: boolean, build: (loaded: string[]) => AgentPrompt) {
  const { contextFiles, skills, append } = await resources(cwd, noContextFiles);
  const prompt = build(contextFiles.map(file => file.path)), { customPrompt, instructions } = promptSections(prompt);
  const blocks: [string, PromptBlock[]][] = [['preamble', [prompt.preamble]], ['addendum', append.map(text => ({ source: 'APPEND_SYSTEM', text }))],
    ['project_context', contextFiles.map(file => ({ source: file.path, text: file.content }))], ['skills', skillsBlock(skills)],
    ['cwd', [{ source: 'cwd', text: cwd }]], ['instructions', prompt.instructions]];
  const system = buildSystemPrompt({ customPrompt, cwd, contextFiles, skills, selectedTools: ['read', 'bash', 'edit', 'write'],
    appendSystemPrompt: append.join('\n\n'), sections: { instructions } });
  console.log(`\n== ${title} (cwd ${cwd}): ${words(system)} words in all`);
  for (const [section, list] of blocks) for (const block of list) console.log(`  ${section.padEnd(15)} ${String(words(block.text)).padStart(6)}  ${block.source}`);
  if (values.full) console.log(`\n${system}\n`);
}

console.log(`Profile ${name} (${dir}), project ${config.project ?? '(none)'}`);
await show('lead', leadCwd, false, loaded => leadPrompt(dir, config, loaded));
const viewless = !config.subagentMemory;
await show(`subagent, context ${context}`, childCwd, context === 'none', loaded => subagentPrompt({ viewless, memorySearch: config.memorySearch,
  delegates: 1 < config.subagentLevels, maxAgents: config.maxAgents, choice: config.subagent, childrenMemory: viewless ? undefined : 'view',
  connected: false, context }, () => profileRules(dir, config.project, loaded)));
