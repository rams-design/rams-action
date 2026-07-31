#!/usr/bin/env node
// Rams Design Review action — the judge in the loop.
// Collects changed UI files with the runner's own git, sends them to the
// hosted engine via MCP, writes structured findings + applyable patches,
// and gates the workflow per fail-on. We judge; your tools repair.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const inp = (name, dflt) => process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? dflt;
const API_KEY = inp('api-key');
const MODE = inp('mode', 'pr');
const FAIL_ON = inp('fail-on', 'critical');
const MAX_FILES = Math.min(parseInt(inp('max-files', '20'), 10) || 20, 20);
const MCP = 'https://worker.rams.ai/mcp';
const STATE = '.rams/last-reviewed-ref';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const summary = (md) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

if (!API_KEY) fail('api-key is required (free at https://www.rams.ai/app/settings)');

// 1. What changed?
const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|html|htm|css|scss|sass|less|swift)$/i;
let range;
if (MODE === 'since-last-run') {
  if (existsSync(STATE)) {
    const since = readFileSync(STATE, 'utf8').trim();
    range = sh(`git cat-file -t ${since} 2>/dev/null || true`) === 'commit' ? `${since}..HEAD` : null;
  } else range = null; // first run: no state — review the most recently touched UI files
} else {
  const base = process.env.GITHUB_BASE_REF;
  range = base ? `origin/${base}...HEAD` : 'HEAD~1..HEAD';
}

let files;
if (range) {
  files = sh(`git diff --name-only --diff-filter=d ${range}`).split('\n').filter(f => UI_EXT.test(f));
} else {
  files = sh(`git ls-files`).split('\n').filter(f => UI_EXT.test(f))
    .map(f => ({ f, t: parseInt(sh(`git log -1 --format=%ct -- "${f}"`) || '0', 10) }))
    .sort((a, b) => b.t - a.t).slice(0, MAX_FILES).map(x => x.f);
}
files = [...new Set(files)].filter(f => existsSync(f)).slice(0, MAX_FILES);

if (files.length === 0) {
  console.log('No changed UI files — nothing to review.');
  summary('**Rams:** no changed UI files — skipped.');
  out('score', ''); out('critical-count', '0');
  if (MODE === 'since-last-run') { mkdirSync('.rams', { recursive: true }); writeFileSync(STATE, sh('git rev-parse HEAD') + '\n'); }
  process.exit(0);
}
console.log(`Reviewing ${files.length} UI file(s):\n  ${files.join('\n  ')}`);

// 2. The judge.
const payload = files.map(f => ({ path: f, content: readFileSync(f, 'utf8') }));
const res = await fetch(MCP, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${API_KEY}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'review_files', arguments: { files: payload, context: `gh-action ${process.env.GITHUB_REPOSITORY ?? ''}`.trim() } },
  }),
});
const raw = await res.text();
if (!res.ok) fail(`Rams API ${res.status}: ${raw.slice(0, 200)}`);
const dataLine = raw.split('\n').find(l => l.startsWith('data: ')) ?? raw;
const parsed = JSON.parse(dataLine.startsWith('data: ') ? dataLine.slice(6) : dataLine);
if (parsed.error || parsed.result?.isError) {
  fail(`Review failed: ${parsed.error?.message ?? parsed.result?.content?.[0]?.text?.slice(0, 200)}`);
}
const sc = parsed.result?.structuredContent;
if (!sc) fail('No structured result from the engine (is the worker up to date?)');

// 3. Artifacts.
mkdirSync('rams-review/patches', { recursive: true });
writeFileSync('rams-review/issues.json', JSON.stringify(sc, null, 2));
let patchCount = 0;
for (const issue of sc.issues ?? []) {
  if (issue.patch) writeFileSync(join('rams-review/patches', `${String(++patchCount).padStart(3, '0')}.patch`), issue.patch);
}
const criticals = (sc.issues ?? []).filter(i => i.severity === 'critical').length;
out('score', String(sc.score));
out('critical-count', String(criticals));
out('issues-json', 'rams-review/issues.json');
out('patches-dir', 'rams-review/patches');

// 4. The human-readable verdict.
summary(`## Rams Design Review — ${sc.score}/100
${sc.direction ? `\n> ${sc.direction}\n` : ''}
| severity | file | finding |
| --- | --- | --- |
${(sc.issues ?? []).map(i => `| ${i.severity} | \`${i.file}:${i.line}\` | ${i.title} |`).join('\n') || '| — | — | clean |'}

${patchCount} applyable patch(es) in \`rams-review/patches/\` · findings in \`rams-review/issues.json\``);
console.log(`Score: ${sc.score}/100 · ${sc.issues?.length ?? 0} finding(s) · ${criticals} critical · ${patchCount} patch(es)`);

// 5. State for since-last-run.
if (MODE === 'since-last-run') {
  mkdirSync('.rams', { recursive: true });
  writeFileSync(STATE, sh('git rev-parse HEAD') + '\n');
  console.log(`Wrote ${STATE} — commit it to advance the review window.`);
}

// 6. The gate.
if (FAIL_ON === 'critical' && criticals > 0) fail(`${criticals} critical design finding(s) — see the step summary. Patches are in rams-review/patches/.`);
const m = FAIL_ON.match(/^score<(\d+)$/);
if (m && sc.score < parseInt(m[1], 10)) fail(`Score ${sc.score} below the ${m[1]} floor.`);
console.log('Gate: pass.');
