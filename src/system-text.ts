import { allowSearch, CONTINUITY, IMPORT_GUIDANCE, SEARCH_DOC, VIEW_DOC } from './core/prompts.ts';
import { CONNECTED, delegation, MASTER, memoryHint, modelsHint, NO_DELEGATION, NOT_CONNECTED, STEERABLE, SUBAGENT, SUBAGENT_NO_VIEW, WINDOW, WINDOW_STEERABLE } from './prompts.ts';
import { joinBlocks, profileRules, type ModelChoice, type ProfileConfig, type PromptBlock } from './profiles.ts';

// What OptChat puts in each agent's prompt, as labelled blocks: the runtime hooks join them, and `scripts/loads.ts`
// lists them, so what the listing shows is what the agents get. Pi adds its own sections around them (context files,
// skills, cwd); `customPrompt` replaces Pi's preamble and `instructions` is the section at the end.

/** OptChat's own text, named after the constant it comes from. */
const builtin = (name: string, text: string): PromptBlock => ({ source: `built-in: ${name}`, text });
export type AgentPrompt = { preamble: PromptBlock; instructions: PromptBlock[] };
export const promptSections = (prompt: AgentPrompt) => ({ customPrompt: prompt.preamble.text, instructions: joinBlocks(prompt.instructions) });

/** The main agent's, read every turn. `loaded` are the context files Pi loaded from its cwd. */
export function leadPrompt(dir: string, config: ProfileConfig, loaded: string[]): AgentPrompt {
  const preamble = allowSearch(`${MASTER}\n\n${modelsHint(config.subagent)}\n\n${memoryHint(config.subagentMemory ? 'view' : 'none')}\n\n${VIEW_DOC}${config.previousExchange ? CONTINUITY : ''}${config.memorySearch ? SEARCH_DOC : ''}`, config.memorySearch);
  return { preamble: builtin('MASTER + modelsHint + memoryHint + VIEW_DOC', preamble),
    instructions: [...profileRules(dir, config.project, loaded), builtin('IMPORT_GUIDANCE', IMPORT_GUIDANCE)] };
}

/** How a subagent was started, as far as its prompt depends on it. */
export type ChildShape = { viewless: boolean; memorySearch: boolean; delegates: boolean; maxAgents: number; choice: ModelChoice;
  childrenMemory?: 'view' | 'none'; connected: boolean; context?: string };
/** A subagent's, read every run. `rules` reads the profile's (see `profileRules`); a child started with context 'none'
 * (a blind run, a judge) reads none of them, only its task and OptChat's own text. */
export function subagentPrompt(shape: ChildShape, rules: () => PromptBlock[]): AgentPrompt {
  const preamble = shape.viewless ? builtin('SUBAGENT_NO_VIEW', SUBAGENT_NO_VIEW)
    : builtin('SUBAGENT + VIEW_DOC', allowSearch(`${SUBAGENT}\n\n${VIEW_DOC}${shape.memorySearch ? SEARCH_DOC : ''}`, shape.memorySearch));
  return { preamble, instructions: [...shape.context === 'none' ? [] : rules(), builtin('IMPORT_GUIDANCE', IMPORT_GUIDANCE),
    shape.delegates ? builtin('delegation', delegation(shape.maxAgents, shape.choice, shape.childrenMemory)) : builtin('NO_DELEGATION', NO_DELEGATION),
    builtin('STEERABLE', STEERABLE), shape.connected ? builtin('CONNECTED', CONNECTED) : builtin('NOT_CONNECTED', NOT_CONNECTED)] };
}

/** A connected window in its own Pi, read every run. */
export function windowPrompt(dir: string, config: ProfileConfig, loaded: string[]): AgentPrompt {
  return { preamble: builtin('WINDOW + VIEW_DOC', allowSearch(`${WINDOW}\n\n${VIEW_DOC}${config.memorySearch ? SEARCH_DOC : ''}`, config.memorySearch)),
    instructions: [...profileRules(dir, config.project, loaded), builtin('IMPORT_GUIDANCE', IMPORT_GUIDANCE), builtin('WINDOW_STEERABLE', WINDOW_STEERABLE)] };
}
