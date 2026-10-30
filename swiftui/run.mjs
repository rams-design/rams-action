// RAMS-461: the action's `render-swiftui: true` path. Runs on a macOS job:
// render the changed SwiftUI previews, keep the PNGs as files in
// rams-review/renders/, and send each one to the worker's render lane.
// Shadow by design: nothing here fails the job except a broken setup.
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { renderSwiftUI } from './render.mjs';
import { uploadRenders, prFromEvent } from './lib.mjs';

export async function runSwiftUI({ inp, apiKey, workerBase }) {
  const summary = (md) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (process.platform !== 'darwin') {
    console.error('::error::render-swiftui needs a macOS runner (runs-on: macos-15).');
    process.exit(1);
  }
  const base = process.env.GITHUB_BASE_REF;
  const range = base ? `origin/${base}...HEAD` : 'HEAD~1..HEAD';
  const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', range], { encoding: 'utf8' }).split('\n').filter(Boolean);

  const outDir = resolve('rams-review/renders');
  const report = await renderSwiftUI({
    root: '.', changed, outDir,
    project: inp('swiftui-project') || undefined,
    scheme: inp('swiftui-scheme') || undefined,
    device: inp('swiftui-device') || undefined,
    runtime: inp('swiftui-runtime') || undefined,
    schemes: inp('swiftui-dark', 'true') === 'false' ? ['light'] : ['light', 'dark'],
  });

  let event = null;
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* not an event run */ }
  const pr = prFromEvent(event);
  const sha = pr.sha ?? process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const results = report.shots.length
    ? await uploadRenders({
      shots: report.shots, readPng: (s) => readFileSync(s.path), base: workerBase, apiKey,
      repo: process.env.GITHUB_REPOSITORY, pr: pr.number, sha, device: report.device,
    })
    : [];

  for (const r of results) console.log(`upload ${r.png}: ${r.outcome}`);
  summary(`## Rams SwiftUI renders
${report.shots.length} render(s) on ${report.device ?? 'no simulator'} (build ${Math.round(report.buildMs / 1000)}s, render ${Math.round(report.renderMs / 1000)}s)

| file | view | scheme | upload |
| --- | --- | --- | --- |
${report.shots.map((s, i) => `| \`${s.file}\` | ${s.view} | ${s.scheme} | ${results[i]?.outcome ?? ''} |`).join('\n') || '| none | | | |'}
${report.dropped.length ? `\nDropped (did not compile on the runner): ${report.dropped.map((d) => `\`${d.file}\` ${d.view}`).join(', ')}` : ''}
${report.skipped.length ? `\nSkipped: ${report.skipped.map((s) => `${s.file ?? ''} ${s.name ?? ''} (${s.reason})`).join(', ')}` : ''}

PNGs in \`rams-review/renders/\` (upload them with actions/upload-artifact to keep them).`);
  return { report, results };
}
