/**
 * Configuration for the bli-sync plugin.
 *
 * Every path has a default that matches the NixOS deployment, and every one
 * can be overridden — by the plugin's profile config, or by an environment
 * variable (the scheduler runs the plugin's CLI in a separate process, so it
 * only sees the environment).
 *
 * Three kinds of location, deliberately kept apart:
 *
 *   codeDir   the plugin package itself (read-only, version controlled)
 *   vault     the Obsidian knowledge base (raw data, rendered notes)
 *   runtime   venv, login cookies, logs, state (outside the knowledge base,
 *             because the cookies are a secret and must never be committed)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The plugin package root (lib/ -> ..). */
export const PACKAGE_DIR = path.resolve(HERE, '..');
/** Where the Python stage scripts live. */
export const CODE_DIR = path.join(PACKAGE_DIR, 'python');

export const DEFAULTS = {
  codeDir: CODE_DIR,
  vault: '/mnt/data/agents/Obsidian/青枫浦上Q',
  videos: '/mnt/data/agents/清枫浦上',
  runtime: '/mnt/data/agents/.bli-sync',
  stateDir: '/mnt/data/agents/.dsh/bli-sync',
  chatId: '',
  /** Human-readable name of the chat above; only used in tool descriptions and messages. */
  chatLabel: '清枫浦上充电记录',
  python: 'python3',
  /** Timeouts for the individual stages of one collection pass. */
  stageTimeoutMs: {
    login: 5 * 60 * 1000,
    dynamics: 45 * 60 * 1000,
    comments: 180 * 60 * 1000,
    videos: 45 * 60 * 1000,
    downloads: 45 * 60 * 1000,
    backfill: 30 * 60 * 1000,
  },
  reportTimeoutMs: 10 * 60 * 1000,
  /** Tail length kept for each recorded run. */
  logTailChars: 4000,
};

/**
 * Merge the plugin config, the environment and the defaults.
 * Precedence: plugin config > environment > defaults.
 */
export function resolveConfig(config = {}, env = process.env) {
  const merged = { ...DEFAULTS, ...config };
  merged.codeDir = config.codeDir || env.BLI_SYNC_CODE_DIR || DEFAULTS.codeDir;
  merged.vault = config.vault || env.BLI_SYNC_VAULT || DEFAULTS.vault;
  merged.videos = config.videos || env.BLI_SYNC_VIDEOS || DEFAULTS.videos;
  merged.runtime = config.runtime || env.BLI_SYNC_RUNTIME || DEFAULTS.runtime;
  merged.stateDir = config.stateDir || env.BLI_SYNC_STATE_DIR || DEFAULTS.stateDir;
  merged.chatId = config.chatId || env.BLI_SYNC_CHAT_ID || DEFAULTS.chatId;
  merged.chatLabel = config.chatLabel || env.BLI_SYNC_CHAT_LABEL || DEFAULTS.chatLabel;
  merged.python = config.python || env.BLI_SYNC_PYTHON || DEFAULTS.python;

  // Derived locations.
  merged.rawDir = path.join(merged.vault, '90-附件', 'raw');
  merged.subsDir = path.join(merged.vault, '90-附件', 'subs');
  merged.logDir = path.join(merged.runtime, 'logs');
  merged.venvDir = path.join(merged.runtime, 'venv');
  merged.venvPython = path.join(merged.venvDir, 'bin', 'python');
  merged.cookieFile = path.join(merged.runtime, 'cookies.txt');
  merged.stateFile = path.join(merged.stateDir, 'state.json');
  return merged;
}
