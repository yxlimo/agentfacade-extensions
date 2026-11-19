/**
 * bli-sync — a Bilibili creator's content pipeline as a harness plugin.
 *
 * The plugin owns the whole pipeline: it fetches a creator's posts, comments
 * and video list, downloads the new videos, and renders the result into an
 * Obsidian knowledge base. The Python stage scripts live in `python/` inside
 * this package; the orchestration (order of the stages, login repair, log
 * scanning, report delivery) lives in `lib/pipeline.js`.
 *
 * The plugin exposes four tools:
 *
 *   bli_status    — what the corpus currently contains and when it last ran
 *   bli_sync      — run one incremental collection pass (long running)
 *   bli_progress  — build the daily progress report and publish it to Feishu
 *   bli_login     — check (and if needed repair) the Bilibili login state
 *
 * The same operations are reachable from the command line (`bli-sync sync`,
 * `bli-sync progress`, ...) so that scheduled jobs can run them without an
 * agent. Both entry points share the same orchestration code.
 */
import {
  HELPERS,
  MANUAL_STEPS,
  MANUAL_STEP_NAMES,
  chatIdFromSession,
  readState,
  readCorpusFacts,
  recordRun,
  pushToFeishu,
  runPython,
  runStep,
  runSync,
  venvReady,
} from './pipeline.js';
import { DEFAULTS, resolveConfig } from './config.js';

export const name = 'bli-sync';
export const inject = ['tools'];

/** Why a report call from the wrong conversation is refused rather than published. */
const EXEC_REFUSAL = (label) =>
  `this report publishes to the Feishu group "${label}", and this conversation is not that group.`;


const text = (value) => ({ content: [{ type: 'text', text: value }] });

function statusReport(config) {
  const state = readState(config);
  const facts = readCorpusFacts(config);
  const runs = state.runs ?? {};
  const lines = [
    'Bilibili sync pipeline status',
    `- vault: ${config.vault}`,
    `- python env: ${venvReady(config) ? 'ready' : 'MISSING (run the provisioning step)'}`,
    `- dynamics collected: ${facts.dynamics ?? 'unknown'}`,
    `- videos collected: ${facts.videos ?? 'unknown'}`,
    `- comment threads collected: ${facts.comments ?? 'unknown'}`,
    `- subtitles on disk: ${facts.subtitles}`,
  ];
  for (const [key, label] of [['sync', 'last sync'], ['progress', 'last report'], ['login', 'login check']]) {
    const run = runs[key];
    lines.push(run
      ? `- ${label}: ${run.at} (exit ${run.code}${run.error ? `, ${run.error}` : ''})`
      : `- ${label}: never`);
  }
  const lastSync = runs.sync;
  if (lastSync?.tail) {
    lines.push('', 'last sync output (tail):', lastSync.tail.trim());
  }
  return lines.join('\n');
}

/** Turn a script result into a tool payload. */
function resultText(label, result) {
  const body = (result.output ?? '').trim();
  const head = `${label}: exit ${result.code}${result.error ? ` (${result.error})` : ''}`;
  return text(body ? `${head}\n\n${body}` : head);
}

export function apply(ctx, config = {}) {
  const options = resolveConfig(config);
  ctx.effect(() => {
    const disposers = [];
    // Use stderr instead of ctx.logger: a plugin-scoped logger does not
    // reach journald, so nothing would show up in the systemd logs.
    console.error(`[bli-sync] applying (vault ${options.vault})`);

    /** Register one tool; a failing registration must not kill the plugin. */
    const register = (definition) => {
      try {
        disposers.push(ctx.tools.register(definition));
        console.error(`[bli-sync] tool "${definition.name}" registered`);
      } catch (err) {
        console.error(`[bli-sync] tool "${definition.name}" failed to register: ${err?.message ?? err}`);
      }
    };

    const emptyParameters = { type: 'object', properties: {} };
    const textOutput = {
      schema: { type: 'object', properties: { content: { type: 'array', items: { type: 'object' } } } },
      render(_args, value) { return value.content; },
    };

    register({
      name: 'bli_status',
      description:
        'Inspect the Bilibili sync pipeline: corpus size, whether the Python environment is ready, '
        + 'and the outcome of the last sync / report / login check. Read-only: no side effects, '
        + 'safe to call in any conversation.',
      parameters: emptyParameters,
      output: textOutput,
      async execute() {
        return text(statusReport(options));
      },
    });

    register({
      name: 'bli_sync',
      description:
        'Run one incremental pass of the Bilibili collection pipeline (check the login state, fetch '
        + 'new posts and comments, download the new videos, backfill the manifest). This is long '
        + 'running — up to a few hours — and it fetches from the network. Only call it when the user '
        + 'explicitly asked to sync now.',
      parameters: emptyParameters,
      output: textOutput,
      async execute() {
        if (!venvReady(options)) {
          return text('The pipeline Python environment is missing. Provision it before syncing.');
        }
        const result = await runSync(options);
        recordRun(options, 'sync', result);
        return resultText('sync', result);
      },
    });

    register({
      name: 'bli_progress',
      description:
        'Build the daily progress report for the Bilibili pipeline and publish it to the Feishu group '
        + `"${options.chatLabel}". `
        + 'This tool refuses to publish from any other conversation: it is bound to that one group. '
        + 'If it reports a refusal, the report was NOT sent — answer the user in the current '
        + 'conversation with bli_status instead.',
      parameters: emptyParameters,
      output: textOutput,
      async execute(_args, exec) {
        const here = chatIdFromSession(exec?.agent?.id);
        if (!here || here !== options.chatId) {
          return text(
            `refused: ${EXEC_REFUSAL(options.chatLabel)}\n\n`
            + 'Nothing was published. Use bli_status and answer the user in this conversation.',
          );
        }
        const result = await runPython(options, HELPERS.progress, {
          timeoutMs: options.reportTimeoutMs,
        });
        recordRun(options, 'progress', result);
        const report = (result.output ?? '').trim();
        if (result.code === 0 && report) {
          const pushed = await pushToFeishu(options, report);
          return text(pushed.ok
            ? `report published to the Feishu group "${options.chatLabel}"\n\n${report}`
            : `report built but not published (${pushed.reason})\n\n${report}`);
        }
        return resultText('progress report', result);
      },
    });

    register({
      name: 'bli_login',
      description:
        'Check whether the Bilibili login state used by the pipeline is still valid, and refresh it '
        + 'from CookieCloud when it is not. Returns the login status.',
      parameters: emptyParameters,
      output: textOutput,
      async execute() {
        const check = await runPython(options, HELPERS.login, {
          args: ['--check'],
          timeoutMs: options.stageTimeoutMs.login,
        });
        const output = check.output ?? '';
        if (/登录态\s*OK/.test(output)) {
          recordRun(options, 'login', { ...check, error: null });
          return text(`login state OK\n${output.trim()}`);
        }
        const refresh = await runPython(options, HELPERS.login, {
          timeoutMs: options.stageTimeoutMs.login,
        });
        recordRun(options, 'login', refresh);
        return resultText('login refresh', refresh);
      },
    });

    register({
      name: 'bli_step',
      description:
        'Run one of the knowledge-base tidying steps by name. These are the stages that turn the '
        + 'collected raw data into curated material and finally into the Obsidian notes. '
        + 'SIDE EFFECT: writes files into the knowledge base. Only call it when the user named a step. '
        + `Known steps: ${MANUAL_STEP_NAMES.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          step: {
            type: 'string',
            description: `Which step to run. One of: ${MANUAL_STEP_NAMES.join(', ')}.`,
          },
        },
        required: ['step'],
      },
      output: textOutput,
      async execute(args) {
        const name = String(args?.step ?? '').trim();
        if (!name) {
          return text(`Which step? Known steps: ${MANUAL_STEP_NAMES.join(', ')}.`);
        }
        const result = await runStep(options, name);
        return resultText(`step ${name}`, result);
      },
    });

    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* tools may already be gone */ }
      }
    };
  });
}

export { DEFAULTS, resolveConfig };
