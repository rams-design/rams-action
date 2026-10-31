// RAMS-461 (EYES 4): render the SwiftUI previews of changed files to PNGs on
// a macOS runner. The customer's own runner, their own code, their own
// simulator; nothing is committed and the checkout is restored after.
//
//   1. changed .swift files inside the app's source root -> their previews
//   2. append a wrapper per preview to the same file (private data stays in
//      scope) and the renderer to the @main file
//   3. xcodebuild for the simulator; a compile error inside one wrapper
//      drops that preview and rebuilds (twice at most)
//   4. launch the app with a tiny injected dylib that calls the renderer;
//      each view is drawn full-device, light and dark, to the app's tmp/
//   5. copy the PNGs + manifest out, restore every touched file
//
// Restore is unconditional (journal.mjs): originals are journaled before the
// first write and put back on success, throw, SIGINT/SIGTERM and crash.
// Children (xcodebuild, simctl, the app) get an env without INPUT_* or Rams
// keys. The build is async with a timeout so a cancel can still restore.
//
// CLI (the local proof): node swiftui/render.mjs --root <repo> --files a.swift,b.swift --out <dir>
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  changedSwiftFiles, extractPreviews, dedupePreviews, buildFileAppend, buildHarness,
  entriesWithErrors, harnessRowSpans, isAppEntry, filesInAppRoot, pickSimulator, childEnv, splitNul, RENDER_LIMITS,
} from './lib.mjs';
import { createJournal } from './journal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const BUILD_TIMEOUT_MS = 15 * 60_000;

/** Sync child, with the scrubbed env. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts, env: childEnv(opts.env ?? process.env) });
  return { code: r.status ?? (r.error ? -1 : 0), out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', error: r.error };
}

/** Async child with a timeout (SIGTERM, then SIGKILL 10s later); keeps the last 8 MB of output. */
export function runAsync(cmd, args, { cwd, timeoutMs = BUILD_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const keep = (d) => { out += d; if (out.length > 8 * 1024 * 1024) out = out.slice(-8 * 1024 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolveP({ code: -1, out: out + String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolveP({ code: code ?? -1, out, timedOut }); });
  });
}

const must = (r, what) => { if (r.code !== 0) throw new Error(`${what} failed (${r.code}):\n${r.out.split('\n').slice(-25).join('\n')}`); return r; };

function listSwift(root, exec) {
  const r = exec.run('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', '*.swift'], { cwd: root });
  return r.code === 0 ? splitNul(r.stdout) : [];
}

/** Read a file, or null (a vanished or unreadable path is skipped, never fatal). */
function readOr(root, f) {
  try { return readFileSync(join(root, f), 'utf8'); } catch { return null; }
}

/** The Xcode container + scheme to build. Explicit inputs win. */
function detectProject(root, { project, scheme }, exec) {
  let container = project;
  if (!container) {
    const top = readdirSync(root);
    const ws = top.find((f) => f.endsWith('.xcworkspace'));
    container = ws ?? top.find((f) => f.endsWith('.xcodeproj'));
  }
  if (!container) throw new Error('no .xcodeproj or .xcworkspace at the repo root (set swiftui-project)');
  const flag = container.endsWith('.xcworkspace') ? '-workspace' : '-project';
  if (!scheme) {
    const list = JSON.parse(must(exec.run('xcodebuild', ['-list', '-json', flag, container], { cwd: root }), 'xcodebuild -list').stdout);
    const schemes = (list.project ?? list.workspace)?.schemes ?? [];
    const base = container.replace(/\.(xcodeproj|xcworkspace)$/, '');
    scheme = schemes.find((s) => s === base) ?? schemes[0];
  }
  if (!scheme) throw new Error(`no scheme found in ${container} (set swiftui-scheme)`);
  return { flag, container, scheme };
}

export async function renderSwiftUI({
  root, changed, outDir, project, scheme, device, runtime, schemes = ['light', 'dark'],
  maxRenders = RENDER_LIMITS.maxRenders, buildTimeoutMs = BUILD_TIMEOUT_MS, log = console.log,
  exec = { run, runAsync }, proc = process,
}) {
  root = realpathSync(root);
  const report = { shots: [], skipped: [], dropped: [], device: null, buildMs: 0, renderMs: 0 };

  // 1. what to render
  const all = listSwift(root, exec);
  const appFile = all.find((f) => { const src = readOr(root, f); return src !== null && isAppEntry(src); });
  if (!appFile) { report.skipped.push({ reason: 'no @main App file' }); return report; }
  const files = filesInAppRoot(changedSwiftFiles(changed).filter((f) => existsSync(join(root, f))), appFile);
  const perFile = new Map();
  let budget = Math.max(1, Math.floor(maxRenders / schemes.length));
  for (const f of files) {
    const text = readOr(root, f);
    if (text === null) { report.skipped.push({ file: f, reason: 'unreadable' }); continue; }
    const { previews, skipped } = extractPreviews(text);
    for (const s of skipped) report.skipped.push({ file: f, ...s });
    const take = dedupePreviews(previews).slice(0, budget);
    budget -= take.length;
    if (take.length) perFile.set(f, take);
    if (budget <= 0) break;
  }
  if (perFile.size === 0) { log('SwiftUI: no previews in the changed app files.'); return report; }

  const proj = detectProject(root, { project, scheme }, exec);
  const journal = createJournal(root, { proc });
  const dd = mkdtempSync(join(tmpdir(), 'rams-dd-'));
  let dropped = new Set();
  let bootedHere = null;

  try {
    // 2 + 3. append, build, drop what does not compile, rebuild
    let built = false;
    for (let attempt = 0; attempt < 3 && !built; attempt++) {
      journal.restore();
      const appends = {};
      const entries = [];
      const extra = new Map(); // file -> appended text
      const newlines = (b) => { let n = 0; for (const c of b) if (c === 10) n++; return n; };
      for (const [f, previews] of perFile) {
        const src = journal.touch(f);
        const keep = previews.filter((_, i) => !dropped.has(`${f}#${i}`));
        if (!keep.length) continue;
        const { text, entries: es } = buildFileAppend(f, keep);
        // re-key dropped by original index: buildFileAppend numbers kept previews
        es.forEach((e, k) => { e.key = `${f}#${previews.indexOf(keep[k])}`; });
        appends[f] = [{ offset: newlines(src), entries: es }];
        extra.set(f, text);
        entries.push(...es);
      }
      if (!entries.length) { log('SwiftUI: every preview failed to compile.'); return report; }
      // the renderer rides at the end of the @main file; its rows map back to
      // entries too (a preview whose file compiles into another target)
      const appSrc = journal.touch(appFile);
      const before = extra.get(appFile) ?? '';
      const harness = buildHarness(entries);
      const hOffset = newlines(appSrc) + (before.match(/\n/g) ?? []).length;
      (appends[appFile] ??= []).push({ offset: hOffset, entries: harnessRowSpans(harness, entries) });
      extra.set(appFile, before + harness);
      for (const [f, text] of extra) journal.append(f, text);

      log(`SwiftUI: building ${proj.scheme} with ${entries.length} preview(s) (attempt ${attempt + 1})`);
      const t0 = Date.now();
      const b = await exec.runAsync('xcodebuild', [proj.flag, proj.container, '-scheme', proj.scheme, '-configuration', 'Debug',
        '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', dd,
        'CODE_SIGNING_ALLOWED=NO', 'build'], { cwd: root, timeoutMs: buildTimeoutMs });
      report.buildMs += Date.now() - t0;
      if (b.timedOut) throw new Error(`xcodebuild timed out after ${Math.round(buildTimeoutMs / 60_000)} min (swiftui-build-timeout)`);
      if (b.code === 0) { built = true; report.entries = entries; break; }
      const bad = entriesWithErrors(b.out, appends);
      if (!bad.size) throw new Error(`xcodebuild failed outside the generated previews:\n${b.out.split('\n').filter((l) => /error:/.test(l)).slice(0, 15).join('\n')}`);
      for (const e of entries) if (bad.has(e.fn)) { dropped.add(e.key); report.dropped.push({ file: e.file, view: e.view, reason: 'does not compile' }); }
    }
    if (!built) throw new Error('xcodebuild still failing after 3 attempts of dropping previews');
    journal.restore(); // the build is done: the checkout is clean while the simulator runs

    // 4. the injector, the simulator, the launch
    const products = join(dd, 'Build/Products/Debug-iphonesimulator');
    const app = readdirSync(products).find((f) => f.endsWith('.app'));
    if (!app) throw new Error('no .app in the build products');
    const appPath = join(products, app);
    const bundleId = must(exec.run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', join(appPath, 'Info.plist')]), 'read bundle id').stdout.trim();
    const arch = exec.run('uname', ['-m']).stdout.trim() || 'arm64';
    const dylib = join(dd, 'rams_inject.dylib');
    must(exec.run('xcrun', ['-sdk', 'iphonesimulator', 'clang', '-dynamiclib', '-target', `${arch}-apple-ios15.0-simulator`,
      '-o', dylib, join(HERE, 'inject.c'), '-framework', 'CoreFoundation', '-lobjc']), 'compile injector');

    const sdk = exec.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']).stdout.trim();
    const sim = pickSimulator(JSON.parse(must(exec.run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']), 'simctl list').stdout), device, sdk, runtime);
    if (!sim) throw new Error('no iPhone simulator available on this runner');
    report.device = sim.name;
    log(`SwiftUI: ${sim.name} (${sim.runtime.replace(/.*SimRuntime\./, '')})`);
    if (sim.state !== 'Booted') { must(exec.run('xcrun', ['simctl', 'boot', sim.udid]), 'simctl boot'); bootedHere = sim.udid; }
    must(exec.run('xcrun', ['simctl', 'bootstatus', sim.udid, '-b'], { timeout: 300_000 }), 'simctl bootstatus');
    must(exec.run('xcrun', ['simctl', 'install', sim.udid, appPath]), 'simctl install');
    exec.run('xcrun', ['simctl', 'terminate', sim.udid, bundleId]);

    const t1 = Date.now();
    const l = exec.run('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', sim.udid, bundleId], {
      timeout: 60_000 + report.entries.length * schemes.length * 3_000,
      // childEnv drops RAMS_*; the two SIMCTL_CHILD_ vars are the only ones the app gets from us
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib, SIMCTL_CHILD_RAMS_SCHEMES: schemes.join(',') },
    });
    report.renderMs = Date.now() - t1;
    if (!/RAMS_RENDER_DONE/.test(l.out)) log(`SwiftUI: renderer did not finish cleanly:\n${l.out.split('\n').slice(-15).join('\n')}`);

    // 5. collect
    const data = must(exec.run('xcrun', ['simctl', 'get_app_container', sim.udid, bundleId, 'data']), 'app container').stdout.trim();
    const src = join(data, 'tmp', 'rams-renders');
    if (!existsSync(join(src, 'manifest.json'))) throw new Error('the renderer wrote no manifest (see the log above)');
    mkdirSync(outDir, { recursive: true });
    for (const shot of JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))) {
      copyFileSync(join(src, shot.png), join(outDir, shot.png));
      report.shots.push({ ...shot, path: resolve(outDir, shot.png) });
    }
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(report.shots, null, 2));
    return report;
  } finally {
    const failed = journal.close();
    if (failed.length) log(`SwiftUI: ::error::could not restore ${failed.join(', ')} (originals kept in ${journal.dir})`);
    rmSync(dd, { recursive: true, force: true });
    if (bootedHere) exec.run('xcrun', ['simctl', 'shutdown', bootedHere]);
  }
}

// CLI
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const r = await renderSwiftUI({
    root: arg('root') ?? '.', changed: (arg('files') ?? '').split(',').filter(Boolean),
    outDir: resolve(arg('out') ?? 'rams-review/renders'), device: arg('device'), runtime: arg('runtime'), buildTimeoutMs: arg('build-timeout') ? Number(arg('build-timeout')) * 60_000 : undefined, schemes: (arg('schemes') ?? 'light,dark').split(','),
  });
  console.log(JSON.stringify({ ...r, entries: undefined }, null, 2));
}
