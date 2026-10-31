// RAMS-461: the action's `render-swiftui: true` path. Runs on a macOS job:
// render the changed SwiftUI previews, keep the PNGs as files in
// rams-review/renders/, and send each one to the worker's render lane.
//
// Fail soft: this lane is a shadow. Anything that goes wrong (a shallow
// checkout, no project at the root, a build that fails for reasons of its
// own, a timeout) is a ::warning:: plus a step summary, exit 0. The only
// red job is a setup error the workflow author must fix: not macOS.
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { renderSwiftUI, BUILD_TIMEOUT_MS } from './render.mjs';
import { uploadRenders, prFromEvent, splitNul } from './lib.mjs';

export class SetupError extends Error {}

/** Changed paths in this PR (or the last commit), NUL-split so UTF-8 names survive. */
export function changedFiles(env = process.env, exec = execFileSync) {
  const base = env.GITHUB_BASE_REF;
  const range = base ? `origin/${base}...HEAD` : 'HEAD~1..HEAD';
  try {
    return splitNul(exec('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--diff-filter=d', range], { encoding: 'utf8' }));
  } catch (e) {
    throw new Error(`git diff ${range} failed; check out with fetch-depth: 0 (${String(e.message ?? e).split('\n')[0]})`);
  }
}

export async function runSwiftUI({ inp, apiKey, workerBase, platform = process.platform, render = renderSwiftUI, upload = uploadRenders, getChanged = changedFiles }) {
  if (platform !== 'darwin') throw new SetupError('render-swiftui needs a macOS runner (runs-on: macos-15).');
  const changed = getChanged();
  const minutes = parseFloat(inp('swiftui-build-timeout', '15'));
  const report = await render({
    root: '.', changed, outDir: resolve('rams-review/renders'),
    project: inp('swiftui-project') || undefined,
    scheme: inp('swiftui-scheme') || undefined,
    device: inp('swiftui-device') || undefined,
    runtime: inp('swiftui-runtime') || undefined,
    schemes: inp('swiftui-dark', 'true') === 'false' ? ['light'] : ['light', 'dark'],
    buildTimeoutMs: minutes > 0 ? minutes * 60_000 : BUILD_TIMEOUT_MS,
  });

  let event = null;
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* not an event run */ }
  const pr = prFromEvent(event);
  const sha = pr.sha ?? process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const results = report.shots.length
    ? await upload({
      shots: report.shots, readPng: (s) => readFileSync(s.path), base: workerBase, apiKey,
      repo: process.env.GITHUB_REPOSITORY, pr: pr.number, sha, device: report.device,
    })
    : [];
  for (const r of results) console.log(`upload ${r.png}: ${r.outcome}`);
  return { report, results };
}

export function summaryMarkdown({ report, results }) {
  return `## Rams SwiftUI renders
${report.shots.length} render(s) on ${report.device ?? 'no simulator'} (build ${Math.round(report.buildMs / 1000)}s, render ${Math.round(report.renderMs / 1000)}s)

| file | view | scheme | upload |
| --- | --- | --- | --- |
${report.shots.map((s, i) => `| \`${s.file}\` | ${s.view} | ${s.scheme} | ${results[i]?.outcome ?? ''} |`).join('\n') || '| none | | | |'}
${report.dropped.length ? `\nDropped (did not compile on the runner): ${report.dropped.map((d) => `\`${d.file}\` ${d.view}`).join(', ')}` : ''}
${report.skipped.length ? `\nSkipped: ${report.skipped.map((s) => `${s.file ?? ''} ${s.name ?? ''} (${s.reason})`).join(', ')}` : ''}

PNGs in \`rams-review/renders/\` (upload them with actions/upload-artifact to keep them).`;
}

/**
 * The whole lane as an exit code: 0 on success AND on any failure (warning
 * + summary), 1 only for a SetupError. index.mjs exits with what this returns.
 */
export async function swiftuiMain({ summary, warn = (m) => console.log(`::warning::${m}`), error = (m) => console.error(`::error::${m}`), ...opts }) {
  try {
    summary(summaryMarkdown(await runSwiftUI(opts)));
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof SetupError) { error(msg); return 1; }
    warn(`Rams SwiftUI renders skipped: ${msg.split('\n')[0]}`);
    summary(`## Rams SwiftUI renders\nSkipped, the job still passes: ${msg.split('\n')[0]}\n\n\`\`\`\n${msg.slice(0, 2000)}\n\`\`\``);
    return 0;
  }
}

export const stepSummary = (md) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
