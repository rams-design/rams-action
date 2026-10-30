// RAMS-461 review fixes: the render lane fails soft, always restores the
// checkout (throw, signal, crash), maps errors in the @main harness back to
// the preview, keeps keys out of child processes, and refuses bad payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  childEnv, splitNul, harnessRowSpans, buildHarness, buildFileAppend, entriesWithErrors, buildRenderPayload, RENDER_LIMITS,
} from '../swiftui/lib.mjs';
import { createJournal } from '../swiftui/journal.mjs';
import { renderSwiftUI, run, runAsync } from '../swiftui/render.mjs';
import { swiftuiMain, changedFiles } from '../swiftui/run.mjs';

const fakeProc = () => { const p = new EventEmitter(); p.exits = []; p.exit = (c) => p.exits.push(c); return p; };

const APP = 'import SwiftUI\n@main\nstruct DemoApp: App {\n  var body: some Scene { WindowGroup { Text("x") } }\n}\n';
const VIEWS = 'import SwiftUI\nstruct A: View { var body: some View { Text("é") } }\n'
  + '#Preview("one") { A() }\n#Preview("two") { A().padding() }\n#Preview("three") { A().bold() }\n#Preview("four") { A().italic() }\n';

function repo({ project = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rams-render-test-')));
  mkdirSync(join(root, 'Demo'));
  writeFileSync(join(root, 'Demo/DemoApp.swift'), APP);
  writeFileSync(join(root, 'Demo/Views é.swift'), VIEWS); // a non-ASCII path
  if (project) mkdirSync(join(root, 'Demo.xcodeproj'));
  return root;
}
const snapshot = (root) => [readFileSync(join(root, 'Demo/DemoApp.swift'), 'utf8'), readFileSync(join(root, 'Demo/Views é.swift'), 'utf8')];

/** exec double: git lists the two files NUL-separated; the build is scripted. */
function exec(root, build) {
  const calls = [];
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { code: 0, stdout: 'Demo/DemoApp.swift\0Demo/Views é.swift\0', out: '' };
      return { code: 1, stdout: '', out: `unexpected ${cmd}` };
    },
    runAsync: async (cmd, args, opts) => { calls.push([cmd, ...args]); return build(root, opts); },
  };
}
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('childEnv drops action inputs and Rams keys, keeps the rest', () => {
  const env = childEnv({ PATH: '/bin', HOME: '/h', INPUT_API_KEY: 'rams_x', input_api_key: 'rams_y', RAMS_WORKER_URL: 'u', MY_RAMS_TOKEN: 't', DEVELOPER_DIR: '/x' });
  assert.deepEqual(Object.keys(env).sort(), ['DEVELOPER_DIR', 'HOME', 'PATH']);
});

test('run() never hands INPUT_* to a child', () => {
  process.env.INPUT_API_KEY = 'rams_secret_test';
  try {
    const r = run('/usr/bin/env', []);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('rams_secret_test'));
    assert.ok(r.stdout.includes('PATH='));
  } finally { delete process.env.INPUT_API_KEY; }
});

test('runAsync stops a child at its timeout', async () => {
  const r = await runAsync('/bin/sleep', ['5'], { timeoutMs: 100 });
  assert.equal(r.timedOut, true);
});

test('splitNul keeps UTF-8 and spaces', () => {
  assert.deepEqual(splitNul('a/Views é.swift\0b c.swift\0'), ['a/Views é.swift', 'b c.swift']);
});

test('payload refuses control characters and PNGs over 3.7 MB (5 MB base64 at Anthropic)', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
  const shot = { file: 'a.swift', view: 'v', scheme: 'light', width: 1, height: 1, scale: 1 };
  const base = { repo: 'a/b', pr: 1, sha: 'abc1234', device: 'iPhone', shot, png };
  assert.ok(buildRenderPayload(base));
  assert.throws(() => buildRenderPayload({ ...base, shot: { ...shot, view: 'v\nx' } }), /bad view/);
  assert.throws(() => buildRenderPayload({ ...base, shot: { ...shot, file: 'a\x1b.swift' } }), /bad file/);
  assert.throws(() => buildRenderPayload({ ...base, device: 'i\x00' }), /bad device/);
  assert.ok(Math.ceil(RENDER_LIMITS.pngBytes / 3) * 4 < 5 * 1024 * 1024);
  assert.throws(() => buildRenderPayload({ ...base, png: Buffer.concat([png, Buffer.alloc(RENDER_LIMITS.pngBytes)]) }), /png over/);
});

test('harness rows map back to their entry, by line and by name', () => {
  const { entries } = buildFileAppend('Widget/W.swift', [{ kind: 'bare', name: 'W', typeName: 'W' }, { kind: 'bare', name: 'X', typeName: 'X' }]);
  const h = buildHarness(entries);
  const spans = harnessRowSpans(h, entries);
  assert.equal(spans.length, 2);
  const offset = 40;
  const byLine = entriesWithErrors(`/tmp/r/App/App.swift:${offset + spans[1].startLine}:9: error: something odd\n`, { 'App/App.swift': [{ offset, entries: spans }] });
  assert.deepEqual([...byLine], [entries[1].fn]);
  const byName = entriesWithErrors(`/tmp/r/App/App.swift:1:1: error: cannot find '${entries[0].fn}' in scope\n`, { 'App/App.swift': [{ offset: 999, entries: spans }] });
  assert.deepEqual([...byName], [entries[0].fn]);
  assert.equal(entriesWithErrors(`/tmp/r/App/App.swift:1:1: error: cannot find '__rams_zz_9' in scope\n`, { 'App/App.swift': [{ offset: 0, entries: spans }] }).size, 0);
});

test('journal: SIGTERM and a crash restore synchronously, then exit; close unhooks and cleans up', () => {
  const root = repo();
  const before = snapshot(root);
  const proc = fakeProc();
  const j = createJournal(root, { proc, log: () => {} });
  j.append('Demo/DemoApp.swift', '\n// generated\n');
  assert.notEqual(readFileSync(join(root, 'Demo/DemoApp.swift'), 'utf8'), before[0]);
  proc.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(snapshot(root), before, 'restored on SIGTERM');
  assert.deepEqual(proc.exits, [143]);
  j.append('Demo/Views é.swift', '\n// generated\n');
  proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(snapshot(root), before, 'restored on crash');
  assert.deepEqual(proc.exits, [143, 1]);
  assert.ok(existsSync(join(j.dir, 'index.json')), 'originals journaled on disk');
  assert.deepEqual(j.close(), []);
  assert.equal(proc.listenerCount('SIGTERM') + proc.listenerCount('SIGINT') + proc.listenerCount('uncaughtException'), 0);
  assert.equal(existsSync(j.dir), false);
});

test('render: a build failure outside the previews throws and restores every file', async () => {
  const root = repo();
  const before = snapshot(root);
  const proc = fakeProc();
  const ex = exec(root, () => ({ code: 65, out: `${root}/Demo/DemoApp.swift:2:1: error: their own bug\n` }));
  await assert.rejects(renderSwiftUI({ root, changed: ['Demo/Views é.swift'], outDir: join(root, 'out'), scheme: 'Demo', exec: ex, proc, log: () => {} }),
    /outside the generated previews/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(proc.listenerCount('SIGTERM'), 0, 'handlers removed');
  assert.ok(ex.calls.some((c) => c[0] === 'git' && c.includes('-z') && c.includes('core.quotePath=false')));
});

test('render: 3 attempts exhausted throws and restores', async () => {
  const root = repo();
  const before = snapshot(root);
  let builds = 0;
  // every build fails inside the FIRST remaining wrapper of the views file
  const ex = exec(root, (r) => {
    builds++;
    const text = readFileSync(join(r, 'Demo/Views é.swift'), 'utf8');
    return { code: 65, out: `/private${r}/Demo/Views é.swift:${lineOf(text, '@MainActor func __rams_')}:5: error: nope\n`.replace('/private/private', '/private') };
  });
  await assert.rejects(renderSwiftUI({ root, changed: ['Demo/Views é.swift'], outDir: join(root, 'out'), scheme: 'Demo', exec: ex, proc: fakeProc(), log: () => {} }),
    /after 3 attempts/);
  assert.equal(builds, 3);
  assert.deepEqual(snapshot(root), before);
});

test('render: a harness row error (preview in another target) drops that preview, not the run', async () => {
  const root = repo();
  const before = snapshot(root);
  let builds = 0;
  let firstFn = null;
  const ex = exec(root, (r) => {
    builds++;
    if (builds === 1) {
      const app = readFileSync(join(r, 'Demo/DemoApp.swift'), 'utf8');
      const row = app.split('\n').find((l) => l.includes('{ __rams_'));
      firstFn = row.match(/__rams_[0-9a-z]+_\d+/)[0];
      return { code: 65, out: `${r}/Demo/DemoApp.swift:${lineOf(app, row)}:20: error: cannot find '${firstFn}' in scope\n` };
    }
    return { code: 0, out: '' }; // second build passes; there is no .app, so the run stops after
  });
  await assert.rejects(renderSwiftUI({ root, changed: ['Demo/Views é.swift'], outDir: join(root, 'out'), scheme: 'Demo', exec: ex, proc: fakeProc(), log: () => {} }));
  assert.equal(builds, 2, 'rebuilt after the drop instead of aborting');
  assert.deepEqual(snapshot(root), before);
});

test('render: a signal during the build restores the checkout before exit', async () => {
  const root = repo();
  const before = snapshot(root);
  const proc = fakeProc();
  let duringBuild = null;
  const ex = exec(root, (r) => {
    duringBuild = snapshot(r);
    proc.emit('SIGINT', 'SIGINT');
    return { code: 65, out: `${r}/Demo/DemoApp.swift:2:1: error: x\n` };
  });
  await assert.rejects(renderSwiftUI({ root, changed: ['Demo/Views é.swift'], outDir: join(root, 'out'), scheme: 'Demo', exec: ex, proc, log: () => {} }));
  assert.notDeepEqual(duringBuild, before, 'files were modified for the build');
  assert.deepEqual(proc.exits, [130]);
  assert.deepEqual(snapshot(root), before);
});

test('render: no project at the root is an error the action turns into a warning', async () => {
  const root = repo({ project: false });
  await assert.rejects(renderSwiftUI({ root, changed: ['Demo/Views é.swift'], outDir: join(root, 'out'), exec: exec(root, () => ({ code: 0, out: '' })), proc: fakeProc(), log: () => {} }),
    /no \.xcodeproj/);
});

test('changedFiles: a shallow checkout names the fix', () => {
  assert.throws(() => changedFiles({ GITHUB_BASE_REF: 'main' }, () => { throw new Error("fatal: bad revision 'origin/main...HEAD'"); }), /fetch-depth: 0/);
  assert.deepEqual(changedFiles({}, () => 'a é.swift\0b.swift\0'), ['a é.swift', 'b.swift']);
});

test('swiftuiMain: every failure is a warning + summary + exit 0; only non-macOS exits 1', async () => {
  const inp = (_k, d) => d ?? '';
  const cases = [
    ['shallow checkout', { getChanged: () => { throw new Error('git diff origin/main...HEAD failed; check out with fetch-depth: 0'); } }],
    ['no project', { getChanged: () => ['a.swift'], render: async () => { throw new Error('no .xcodeproj or .xcworkspace at the repo root'); } }],
    ['their build is broken', { getChanged: () => ['a.swift'], render: async () => { throw new Error('xcodebuild failed outside the generated previews'); } }],
    ['attempts exhausted', { getChanged: () => ['a.swift'], render: async () => { throw new Error('xcodebuild still failing after 3 attempts'); } }],
  ];
  for (const [name, o] of cases) {
    const warns = [], sums = [];
    const code = await swiftuiMain({ summary: (m) => sums.push(m), warn: (m) => warns.push(m), error: () => {}, inp, apiKey: 'k', workerBase: 'x', platform: 'darwin', ...o });
    assert.equal(code, 0, name);
    assert.equal(warns.length, 1, name);
    assert.match(sums[0], /Skipped, the job still passes/, name);
  }
  const errs = [];
  assert.equal(await swiftuiMain({ summary: () => {}, warn: () => {}, error: (m) => errs.push(m), inp, apiKey: 'k', workerBase: 'x', platform: 'linux' }), 1);
  assert.match(errs[0], /macOS runner/);
  const ok = await swiftuiMain({ summary: () => {}, inp, apiKey: 'k', workerBase: 'x', platform: 'darwin', getChanged: () => [],
    render: async () => ({ shots: [], skipped: [], dropped: [], device: null, buildMs: 0, renderMs: 0 }) });
  assert.equal(ok, 0);
});
