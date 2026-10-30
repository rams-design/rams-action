// RAMS-461: the seams of the SwiftUI render lane that can fail without
// Xcode: changed file -> previews, the appended Swift and its error
// mapping, simulator choice, and the upload (payload + outcomes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedSwiftFiles, maskSwift, extractPreviews, dedupePreviews, buildFileAppend, buildHarness,
  entriesWithErrors, isAppEntry, filesInAppRoot, pickSimulator, buildRenderPayload, uploadRenders,
  prFromEvent, RENDER_PATH, RENDER_LIMITS,
} from '../swiftui/lib.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

test('changedSwiftFiles keeps app Swift, drops tests, packages, build output', () => {
  const got = changedSwiftFiles([
    'note/ContentView.swift', 'note/ContentView.swift', 'loopTests/TimerManagerTests.swift',
    'AsideUITests/Flow.swift', 'Package.swift', 'build/x/GeneratedAssetSymbols.swift',
    'Pods/Foo/Bar.swift', 'web/app.tsx', 'Sources/App/ProfileView.swift', 'App/ViewSpec.swift',
  ]);
  assert.deepEqual(got, ['note/ContentView.swift', 'Sources/App/ProfileView.swift']);
});

test('maskSwift blanks comments and strings but keeps interpolated code and length', () => {
  const src = 'let a = "{ \\(x ? "}" : "{") }" // {\n/* { /* } */ } */ let b = """\n{\n"""';
  const m = maskSwift(src);
  assert.equal(m.length, src.length);
  assert.equal((m.match(/[{}]/g) ?? []).length, 0, 'no brace survives from strings or comments');
  assert.ok(m.includes('x ?'), 'interpolation stays code');
  assert.equal(m.split('\n').length, src.split('\n').length);
});

test('extractPreviews: #Preview with name, traits, braces in strings and comments', () => {
  const src = `import SwiftUI
struct Card: View { var body: some View { Text("{") } }

#Preview("Empty state", traits: .sizeThatFitsLayout) {
  // a } in a comment
  let items: [String] = []
  Card()
    .overlay(Text("closing } brace \\(items.count)"))
}

#Preview {
  Card()
}
`;
  const { previews, skipped } = extractPreviews(src);
  assert.deepEqual(skipped, []);
  assert.equal(previews.length, 2);
  assert.equal(previews[0].kind, 'macro');
  assert.equal(previews[0].name, 'Empty state');
  assert.equal(previews[0].line, 4);
  assert.match(previews[0].body, /let items/);
  assert.match(previews[0].body, /closing \} brace/);
  assert.equal(previews[1].name, 'Preview 2');
  assert.equal(previews[1].body.trim(), 'Card()');
});

test('extractPreviews: PreviewProvider, and the skips we cannot copy', () => {
  const src = `
struct Row_Previews: PreviewProvider { static var previews: some View { Row() } }
#Preview("Toggle") {
  @Previewable @State var on = true
  Toggle("x", isOn: $on)
}
#Preview("Body arg", body: { Row() })
`;
  const { previews, skipped } = extractPreviews(src);
  assert.deepEqual(previews.map((p) => [p.kind, p.name]), [['provider', 'Row_Previews']]);
  assert.deepEqual(skipped.map((s) => [s.name, s.reason]), [['Toggle', 'previewable'], ['Body arg', 'body-argument']]);
});

test('extractPreviews: bare View fallback only when the file has no previews; generics skipped', () => {
  const bare = extractPreviews(`
struct ProofTimerCard: View { var body: some View { Text("25:00") } }
struct Wrapper<Content: View>: View { let c: Content; var body: some View { c } }
struct NotAView { }
`);
  assert.deepEqual(bare.previews.map((p) => [p.kind, p.typeName]), [['bare', 'ProofTimerCard']]);
  const withPreview = extractPreviews('struct A: View { var body: some View { EmptyView() } }\n#Preview { A() }\n');
  assert.deepEqual(withPreview.previews.map((p) => p.kind), ['macro']);
  // a preview inside a comment is not a preview
  assert.deepEqual(extractPreviews('// #Preview { A() }\nlet x = 1\n').previews, []);
});

test('dedupePreviews drops an identical body in the same file (note ContentView)', () => {
  const { previews } = extractPreviews('#Preview{\n  ContentView()\n}\n#Preview {\n  ContentView()\n}\n');
  assert.equal(previews.length, 2);
  assert.equal(dedupePreviews(previews).length, 1);
});

test('buildFileAppend: entry spans point at their own lines; errors map back through the offset', () => {
  const original = 'import SwiftUI\nstruct A: View { var body: some View { EmptyView() } }\n#Preview { A() }\nstruct B: View { let t: String; var body: some View { Text(t) } }\n';
  const previews = [
    { kind: 'macro', name: 'P', body: '\n  A()\n' },
    { kind: 'bare', name: 'B', typeName: 'B' },
  ];
  const { text, entries } = buildFileAppend('app/A.swift', previews);
  const lines = text.split('\n');
  for (const e of entries) {
    assert.ok(lines[e.startLine - 1].includes(e.fn), `${e.fn} starts at its line`);
  }
  assert.match(text, /#if DEBUG/);
  assert.match(text, /AnyView\(B\(\)\)/);
  // the compiler reports B() on the combined file; the path differs by /private
  const offset = (original.match(/\n/g) ?? []).length;
  const bLine = offset + entries[1].startLine;
  const log = [
    `/private/tmp/work/repo/app/A.swift:${bLine}:40: error: missing argument for parameter 't' in call`,
    `/tmp/work/repo/app/Other.swift:3:1: error: unrelated`,
    `/tmp/work/repo/app/A.swift:2:1: error: in the original code, not ours`,
  ].join('\n');
  const bad = entriesWithErrors(log, { 'app/A.swift': { offset, entries } });
  assert.deepEqual([...bad], [entries[1].fn]);
});

test('buildHarness lists every entry and escapes names', () => {
  const swift = buildHarness([{ fn: '__rams_x_0', file: 'a/"q".swift', view: 'Say "hi"' }]);
  assert.match(swift, /@objc\(RamsRenderHarness\)/);
  assert.ok(swift.includes('("__rams_x_0", "a/\\"q\\".swift", "Say \\"hi\\"", { __rams_x_0() })'));
  assert.match(swift, /#if DEBUG && canImport\(UIKit\)/);
});

test('isAppEntry + filesInAppRoot: only files under the @main App folder render', () => {
  assert.equal(isAppEntry('import SwiftUI\n@main\nstruct noteApp: App {\n var body: some Scene { WindowGroup { } } }'), true);
  assert.equal(isAppEntry('@main\nstruct LoopWidgetsBundle: WidgetBundle { }'), false);
  assert.equal(isAppEntry('// @main struct X: App\n'), false);
  assert.deepEqual(
    filesInAppRoot(['loop/ContentView.swift', 'LoopWidgets/LoopLiveActivity.swift', 'loop/sub/Row.swift'], 'loop/loopApp.swift'),
    ['loop/ContentView.swift', 'loop/sub/Row.swift']);
});

test('pickSimulator: newest runtime the SDK supports, preferred name, Pro fallback, pin', () => {
  const list = { devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{ name: 'iPhone 18 Pro', udid: 'beta', isAvailable: true, state: 'Shutdown' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
      { name: 'iPhone Duo', udid: 'duo', isAvailable: true }, { name: 'iPhone 18', udid: 'base', isAvailable: true },
      { name: 'iPhone 18 Pro', udid: 'pro271', isAvailable: true, state: 'Booted' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'rams-proof', udid: 'mine', isAvailable: true }, { name: 'iPhone 17 Pro', udid: 'p265', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ name: 'Apple Watch', udid: 'w', isAvailable: true }],
  } };
  assert.equal(pickSimulator(list, undefined, '27.1').udid, 'pro271', 'beta runtime above the SDK is skipped');
  assert.equal(pickSimulator(list).udid, 'beta', 'no SDK given: newest runtime');
  assert.equal(pickSimulator(list, 'rams-proof', '27.1').udid, 'mine', 'a named device wins');
  assert.equal(pickSimulator(list, 'mine').udid, 'mine', 'udid works too');
  assert.equal(pickSimulator(list, undefined, '27.1', 'iOS-26-5').udid, 'p265', 'runtime pin');
  const noPro = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-1': list.devices['com.apple.CoreSimulator.SimRuntime.iOS-27-1'].slice(0, 2) } };
  assert.equal(pickSimulator(noPro).udid, 'base', 'base iPhone before an odd name');
  assert.equal(pickSimulator({ devices: {} }), null);
});

test('buildRenderPayload: the contract shape, and refusals', () => {
  const shot = { file: 'loop/ContentView.swift', view: 'Preview 1', scheme: 'dark', width: 402, height: 874, scale: 3 };
  const p = buildRenderPayload({ repo: 'hsla0001/loop', pr: 12, sha: 'abc1234', device: 'iPhone 17 Pro', shot, png: PNG });
  assert.deepEqual(Object.keys(p), ['v', 'repo', 'pr', 'sha', 'file', 'view', 'colorScheme', 'device', 'png']);
  assert.equal(p.v, 1);
  assert.equal(p.colorScheme, 'dark');
  assert.deepEqual(p.device, { name: 'iPhone 17 Pro', width: 402, height: 874, scale: 3 });
  assert.deepEqual(Buffer.from(p.png, 'base64'), PNG);
  assert.equal(buildRenderPayload({ repo: 'a/b', pr: undefined, sha: 'abc1234', device: 'x', shot, png: PNG }).pr, null);
  assert.throws(() => buildRenderPayload({ repo: 'nope', pr: 1, sha: 'abc1234', shot, png: PNG }), /bad repo/);
  assert.throws(() => buildRenderPayload({ repo: 'a/b', pr: 1, sha: 'zz', shot, png: PNG }), /bad sha/);
  assert.throws(() => buildRenderPayload({ repo: 'a/b', pr: 1, sha: 'abc1234', shot, png: Buffer.from('GIF89a....') }), /not a png/);
  const big = Buffer.concat([PNG, Buffer.alloc(RENDER_LIMITS.pngBytes)]);
  assert.throws(() => buildRenderPayload({ repo: 'a/b', pr: 1, sha: 'abc1234', shot, png: big }), /png over/);
});

test('uploadRenders: one authed POST per shot; 404 reads as off; failures never throw', async () => {
  const calls = [];
  const replies = [
    async () => ({ status: 202, json: async () => ({ outcome: 'judged' }) }),
    async () => ({ status: 404, json: async () => ({ error: 'Not found' }) }),
    async () => { throw new Error('ECONNRESET'); },
  ];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return replies[calls.length - 1](); };
  const shots = ['a', 'b', 'c', 'bad'].map((n) => ({ png: `${n}.png`, file: 'x.swift', view: n, scheme: 'light', width: 1, height: 1, scale: 3 }));
  const res = await uploadRenders({
    shots, readPng: (s) => (s.png === 'bad.png' ? Buffer.from('nope') : PNG),
    base: 'https://worker.example/', apiKey: 'rams_test', repo: 'hsla0001/loop', pr: 7, sha: 'abcdef1', device: 'iPhone', fetchImpl,
  });
  assert.equal(calls.length, 3, 'the invalid png is never sent');
  assert.equal(calls[0].url, 'https://worker.example' + RENDER_PATH);
  assert.equal(calls[0].init.headers.authorization, 'Bearer rams_test');
  assert.equal(calls[0].init.headers['x-rams-source'], 'github_action');
  assert.equal(JSON.parse(calls[0].init.body).view, 'a');
  assert.deepEqual(res.map((r) => r.outcome), ['judged', 'off', 'upload-error', 'invalid: not a png']);
});

test('prFromEvent: PR runs carry number + head sha; pushes do not', () => {
  assert.deepEqual(prFromEvent({ pull_request: { number: 3, head: { sha: 'abc' } } }), { number: 3, sha: 'abc' });
  assert.deepEqual(prFromEvent({ ref: 'refs/heads/main' }), { number: null, sha: null });
  assert.deepEqual(prFromEvent(null), { number: null, sha: null });
});
