// Public API of the One & Done core: the pure, synchronous game engine that every shell (the
// self-hosted server in server/, the cloud service) wraps. Nothing under core/ does I/O, keeps
// module-level state or reads the clock; see docs/2026_10_16_001_CORE_SHELL_SPLIT.md.

export {
  applyCommand, applyUndo, applyChat, checkPing, nextDeadline,
  UNDO_LIMIT, HISTORY_LIMIT, CHAT_MAX, PING_LIMIT, PING_WINDOW_MS, PING_MAX_CELLS,
} from './engine.js';
export { createGameState, upgradeState, GameError, DM_COLOR, MAX_SCENE_LINKS, newId, randomToken } from './state.js';
export { projectForDm, projectForPlayer, feedForRole, turnProgress } from './project.js';
export { ROLE_STRENGTHS, DEFAULT_ROLE_STRENGTH, isValidRoleStrength, publicRoles, describeStrength } from './roles.js';
export { CATEGORIES, FOLDER_CATEGORIES, SINGLE_FILES, FILE_RE, validateDefs, findItem, itemView } from './content.js';
export { normalizeTemplate } from './templates.js';
export { normalizeHandout, validateAdventure, MAX_HANDOUTS, MAX_HANDOUT_SCENES, HANDOUT_TITLE_MAX, HANDOUT_TEXT_MAX, HANDOUT_NOTES_MAX } from './handouts.js';
export { rollDice, parseDice, isValidDice, DICE_SIDES, DiceError } from './dice.js';
