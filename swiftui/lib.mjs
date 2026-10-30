// RAMS-461 (EYES 4): the pure half of the SwiftUI render lane. Everything
// here is string in, data out, so the tests can pin it without Xcode:
// which changed files count, where their previews are, what Swift gets
// appended on the runner, and what one upload looks like.

/** Changed paths that can hold a SwiftUI view we would render. */
export function changedSwiftFiles(paths) {
  return [...new Set(paths)].filter((p) =>
    /\.swift$/.test(p) &&
    !/(^|\/)Package\.swift$/.test(p) &&
    !/(^|\/)(\.build|DerivedData|Pods|Carthage|build)\//.test(p) &&
    !/(^|\/)[^/]*Tests?\//.test(p) &&           // loopTests/, AsideUITests/, Tests/
    !/(Tests?|Spec)\.swift$/.test(p));
}

/**
 * Same-length copy of Swift source with comment text and string-literal text
 * blanked to spaces (quotes and newlines kept). Interpolations inside strings
 * stay code, so `"\(a ? "x" : "y")"` and braces in comments never confuse the
 * brace matcher. Handles line comments, nested block comments, "..." and """...""".
 */
export function maskSwift(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  // stack of contexts: { t: 'code', depth } (depth counts parens inside an
  // interpolation) | { t: 'str', multi }
  const stack = [{ t: 'code', depth: 0, interp: false }];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i], n = src[i + 1];
    if (top.t === 'code') {
      if (c === '/' && n === '/') {
        while (i < src.length && src[i] !== '\n') blank(i++);
        continue;
      }
      if (c === '/' && n === '*') {
        let d = 0;
        while (i < src.length) {
          if (src[i] === '/' && src[i + 1] === '*') { d++; blank(i); blank(i + 1); i += 2; continue; }
          if (src[i] === '*' && src[i + 1] === '/') { d--; blank(i); blank(i + 1); i += 2; if (d === 0) break; continue; }
          blank(i++);
        }
        continue;
      }
      if (c === '"') {
        const multi = src.startsWith('"""', i);
        stack.push({ t: 'str', multi });
        i += multi ? 3 : 1;
        continue;
      }
      if (top.interp) {
        if (c === '(') top.depth++;
        if (c === ')') {
          if (top.depth === 0) { stack.pop(); blank(i); i++; continue; } // closes \( ... )
          top.depth--;
        }
      }
      i++;
      continue;
    }
    // inside a string literal
    if (c === '\\' && n === '(') { blank(i); blank(i + 1); i += 2; stack.push({ t: 'code', depth: 0, interp: true }); continue; }
    if (c === '\\') { blank(i); if (i + 1 < src.length) blank(i + 1); i += 2; continue; }
    if (top.multi ? src.startsWith('"""', i) : c === '"') { stack.pop(); i += top.multi ? 3 : 1; continue; }
    if (!top.multi && c === '\n') { stack.pop(); i++; continue; } // unterminated: recover at EOL
    blank(i++);
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open` in masked source, or -1. */
export function matchBracket(masked, open) {
  const pairs = { '{': '}', '(': ')' };
  const want = [pairs[masked[open]]];
  for (let i = open + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(') want.push(pairs[c]);
    else if (c === '}' || c === ')') {
      if (c !== want[want.length - 1]) return -1;
      want.pop();
      if (want.length === 0) return i;
    }
  }
  return -1;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** First string literal in an argument list, unescaped enough for a label. */
function firstStringArg(args) {
  const m = args.match(/^\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : null;
}

/**
 * Every renderable preview in one file:
 *   { kind: 'macro', name, body, line }     #Preview("name", traits...) { body }
 *   { kind: 'provider', name, typeName, line }   struct X: PreviewProvider
 *   { kind: 'bare', name, typeName, line }  struct X: View, only when the file
 *     has no previews at all (the build decides whether X() compiles)
 * Plus `skipped: [{ name, line, reason }]` for previews we know we cannot copy.
 */
export function extractPreviews(src) {
  const masked = maskSwift(src);
  const previews = [];
  const skipped = [];
  let macroCount = 0;

  const re = /#Preview\b/g;
  let m;
  while ((m = re.exec(masked))) {
    const line = lineOf(src, m.index);
    let i = m.index + m[0].length;
    while (/\s/.test(masked[i] ?? '')) i++;
    let name = null;
    if (masked[i] === '(') {
      const close = matchBracket(masked, i);
      if (close < 0) { skipped.push({ name: null, line, reason: 'unbalanced' }); continue; }
      const args = src.slice(i + 1, close);
      if (/\bbody\s*:/.test(masked.slice(i + 1, close))) { skipped.push({ name: firstStringArg(args), line, reason: 'body-argument' }); continue; }
      name = firstStringArg(args);
      i = close + 1;
      while (/\s/.test(masked[i] ?? '')) i++;
    }
    if (masked[i] !== '{') { skipped.push({ name, line, reason: 'no-trailing-closure' }); continue; }
    const end = matchBracket(masked, i);
    if (end < 0) { skipped.push({ name, line, reason: 'unbalanced' }); continue; }
    const body = src.slice(i + 1, end);
    macroCount++;
    const label = name ?? `Preview ${macroCount}`;
    if (/@Previewable\b/.test(maskSwift(body))) { skipped.push({ name: label, line, reason: 'previewable' }); continue; }
    previews.push({ kind: 'macro', name: label, body, line });
    re.lastIndex = end;
  }

  const prov = /\bstruct\s+(\w+)\s*:\s*([^{]*)\{/g;
  const views = [];
  while ((m = prov.exec(masked))) {
    const conf = m[2];
    if (/\bPreviewProvider\b/.test(conf)) previews.push({ kind: 'provider', name: m[1], typeName: m[1], line: lineOf(src, m.index) });
    else if (/(^|[\s,])(SwiftUI\.)?View\b/.test(conf) && !/\bwhere\b/.test(conf)) views.push({ name: m[1], line: lineOf(src, m.index) });
  }
  // generic structs (struct Card<Content: View>) cannot be built bare
  const generic = new Set([...masked.matchAll(/\bstruct\s+(\w+)\s*</g)].map((x) => x[1]));

  if (previews.length === 0 && skipped.length === 0) {
    for (const v of views) {
      if (generic.has(v.name)) continue;
      previews.push({ kind: 'bare', name: v.name, typeName: v.name, line: v.line });
    }
  }
  previews.sort((a, b) => a.line - b.line);
  return { previews, skipped };
}

/** Stable short id for a file path (used in generated Swift names). */
export function fileId(path) {
  let h = 2166136261;
  for (const ch of path) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

/** The view a preview builds, as a Swift expression. */
function viewExpr(p, fn) {
  if (p.kind === 'macro') return `${fn}_body()`;
  if (p.kind === 'provider') return `${p.typeName}.previews`;
  return `${p.typeName}()`;
}

/**
 * Swift appended to one changed file on the runner (never committed). Lives
 * in the SAME file so private sample data a preview uses stays in scope.
 * Returns the text plus each entry's line span inside it, so a compile error
 * can be traced to the one preview that caused it.
 */
export function buildFileAppend(path, previews) {
  const id = fileId(path);
  const lines = ['', '', '// rams-render (RAMS-461): generated on the CI runner, never committed', '#if DEBUG', 'import SwiftUI'];
  const entries = [];
  previews.forEach((p, i) => {
    const fn = `__rams_${id}_${i}`;
    const start = lines.length + 1;
    lines.push(`@MainActor func ${fn}() -> AnyView { AnyView(${viewExpr(p, fn)}) }`);
    if (p.kind === 'macro') {
      lines.push(`@MainActor @ViewBuilder func ${fn}_body() -> some View {`);
      lines.push(...p.body.replace(/^\n/, '').replace(/\s+$/, '').split('\n'));
      lines.push('}');
    }
    entries.push({ fn, file: path, view: p.name, kind: p.kind, startLine: start, endLine: lines.length });
  });
  lines.push('#endif', '');
  return { text: lines.join('\n'), entries };
}

const swiftStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';

/**
 * The renderer, appended to the app's @main file. The injected dylib calls
 * RamsRenderHarness.run() once the app is up; each view goes into its own
 * window at the device's full size, light and/or dark, and is drawn to a
 * PNG in the app's tmp/rams-renders with a manifest written after every
 * shot (a crash mid-run keeps what already rendered).
 */
export function buildHarness(entries) {
  const rows = entries.map((e) => `      (${swiftStr(e.fn)}, ${swiftStr(e.file)}, ${swiftStr(e.view)}, { ${e.fn}() }),`).join('\n');
  return `

// rams-render (RAMS-461): generated on the CI runner, never committed
#if DEBUG && canImport(UIKit)
import UIKit
import SwiftUI

@objc(RamsRenderHarness) final class RamsRenderHarness: NSObject {
  @MainActor static func entries() -> [(String, String, String, @MainActor () -> AnyView)] {
    [
${rows}
    ]
  }

  @MainActor @objc static func run() { Task { @MainActor in await render() } }

  @MainActor static func render() async {
    let env = ProcessInfo.processInfo.environment
    let schemes = (env["RAMS_SCHEMES"] ?? "light").split(separator: ",").map(String.init)
    let settle = UInt64(Double(env["RAMS_SETTLE_MS"] ?? "700") ?? 700) * 1_000_000
    let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("rams-renders")
    try? FileManager.default.removeItem(at: out)
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
      print("RAMS_RENDER_NO_SCENE"); exit(4)
    }
    var manifest: [[String: Any]] = []
    for (fn, file, view, make) in entries() {
      for scheme in schemes {
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = scheme == "dark" ? .dark : .light
        window.rootViewController = UIHostingController(rootView: make())
        window.makeKeyAndVisible()
        try? await Task.sleep(nanoseconds: settle)
        let format = UIGraphicsImageRendererFormat(for: window.traitCollection)
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
          _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let name = "\\(fn)-\\(scheme).png"
        if let data = image.pngData() {
          try? data.write(to: out.appendingPathComponent(name))
          manifest.append(["fn": fn, "file": file, "view": view, "scheme": scheme, "png": name,
                           "width": Int(window.bounds.width), "height": Int(window.bounds.height), "scale": Double(format.scale)])
          if let json = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted]) {
            try? json.write(to: out.appendingPathComponent("manifest.json"))
          }
          print("RAMS_RENDERED \\(name)")
        }
        window.isHidden = true
      }
    }
    print("RAMS_RENDER_DONE \\(manifest.count)")
    exit(0)
  }
}
#endif
`;
}

/**
 * Compile errors from xcodebuild output that land inside our appended
 * blocks, mapped to the entries that caused them. `appends` maps a source
 * path RELATIVE to the repo root to { offset, entries } where offset is the
 * original file's newline count. xcodebuild prints absolute paths that may
 * not match the checkout's realpath (/tmp vs /private/tmp), so match by suffix.
 */
export function entriesWithErrors(log, appends) {
  const bad = new Set();
  const re = /^(\/[^:\n]+\.swift):(\d+):\d+: error:/gm;
  let m;
  while ((m = re.exec(log))) {
    const rel = Object.keys(appends).find((k) => m[1] === k || m[1].endsWith('/' + k));
    const a = rel && appends[rel];
    if (!a) continue;
    const line = parseInt(m[2], 10) - a.offset;
    const hit = a.entries.find((e) => line >= e.startLine && line <= e.endLine);
    if (hit) bad.add(hit.fn);
  }
  return bad;
}

/** Only pull_request runs carry a PR; anything else uploads pr: null. */
export function prFromEvent(event) {
  const pr = event?.pull_request;
  return pr ? { number: pr.number, sha: pr.head?.sha ?? null } : { number: null, sha: null };
}

export const RENDER_LIMITS = { maxRenders: 12, pngBytes: 4 * 1024 * 1024 };

/** One upload: the worker contract (see swiftui/CONTRACT.md). */
export function buildRenderPayload({ repo, pr, sha, device, shot, png }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo: ${repo}`);
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`bad sha: ${sha}`);
  if (!Buffer.isBuffer(png) || png.length === 0) throw new Error('png missing');
  if (png.length > RENDER_LIMITS.pngBytes) throw new Error(`png over ${RENDER_LIMITS.pngBytes} bytes`);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  return {
    v: 1,
    repo,
    pr: Number.isInteger(pr) ? pr : null,
    sha,
    file: shot.file,
    view: shot.view,
    colorScheme: shot.scheme === 'dark' ? 'dark' : 'light',
    device: { name: device, width: shot.width, height: shot.height, scale: shot.scale },
    png: png.toString('base64'),
  };
}

/** Same preview body twice in one file renders once (note's ContentView has two). */
export function dedupePreviews(previews) {
  const seen = new Set();
  return previews.filter((p) => {
    const key = p.kind === 'macro' ? `m:${p.body.replace(/\s+/g, ' ').trim()}` : `${p.kind}:${p.typeName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The app's @main App file: `@main struct X: App` (widgets use WidgetBundle). */
export function isAppEntry(src) {
  return /@main\s+(?:public\s+|final\s+)?struct\s+\w+\s*:\s*(?:[\w.]+\s*,\s*)*(?:SwiftUI\.)?App\b/.test(maskSwift(src));
}

/** Changed files we render: inside the app's source root (the @main file's folder). */
export function filesInAppRoot(files, appFile) {
  const root = appFile.includes('/') ? appFile.slice(0, appFile.lastIndexOf('/') + 1) : '';
  return files.filter((f) => f.startsWith(root));
}

/**
 * From `xcrun simctl list devices available -j`: a phone on the NEWEST iOS
 * runtime. The runtime wins over the device name: an app built with the
 * latest SDK can crash on an older runtime (missing weak symbols, seen on
 * loop's glassEffect with iOS 26.0), and device names change by year.
 * A device named (or udid'd) `preferred` wins on the newest runtime that has
 * it; otherwise, on the newest runtime: a 6.1" Pro, a base iPhone, any iPhone.
 * `sdk` ("27.1", from xcrun --show-sdk-version) caps the runtime: a newer
 * beta runtime than the SDK hung loop on a blank screen (27.2 vs 27.1).
 * `runtime` ("iOS-26-5") pins one runtime when the newest misbehaves.
 */
export function pickSimulator(list, preferred, sdk, runtime) {
  const ver = (k) => (k.match(/iOS-(\d+)-(\d+)/) || [0, 0, 0]).slice(1).map(Number);
  const runtimes = Object.keys(list?.devices ?? {})
    .filter((k) => /SimRuntime\.iOS-/.test(k))
    .filter((k) => !runtime || k.endsWith(`.${runtime}`))
    .filter((k) => { if (!sdk) return true; const [x, y] = ver(k); const [sx, sy = 0] = String(sdk).split('.').map(Number); return x < sx || (x === sx && y <= sy); })
    .sort((a, b) => { const [x1, y1] = ver(a), [x2, y2] = ver(b); return x2 - x1 || y2 - y1; });
  const avail = (r) => list.devices[r].filter((d) => d.isAvailable !== false);
  if (preferred) {
    for (const r of runtimes) {
      const d = avail(r).find((x) => x.name === preferred || x.udid === preferred);
      if (d) return { udid: d.udid, name: d.name, runtime: r, state: d.state };
    }
  }
  for (const r of runtimes) {
    const ps = avail(r).filter((d) => /^iPhone/.test(d.name));
    if (!ps.length) continue;
    const d = ps.find((x) => /^iPhone \d+ Pro$/.test(x.name))
      ?? ps.find((x) => /^iPhone \d+$/.test(x.name))
      ?? ps[0];
    return { udid: d.udid, name: d.name, runtime: r, state: d.state };
  }
  return null;
}

export const RENDER_PATH = '/v1/renders/swiftui';

/**
 * Upload each shot (one POST per PNG). Never throws: the render lane is a
 * shadow, so a failed upload is an outcome the job logs, not a red build.
 * Returns [{ png, status, outcome }] where outcome is the worker's
 * (judged | busy | off | ...) or 'upload-error'.
 */
export async function uploadRenders({ shots, readPng, base, apiKey, repo, pr, sha, device, fetchImpl = fetch }) {
  const results = [];
  for (const shot of shots) {
    let body;
    try {
      body = buildRenderPayload({ repo, pr, sha, device, shot, png: readPng(shot) });
    } catch (e) {
      results.push({ png: shot.png, status: 0, outcome: `invalid: ${e.message}` });
      continue;
    }
    try {
      const res = await fetchImpl(base.replace(/\/$/, '') + RENDER_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-rams-source': 'github_action' },
        body: JSON.stringify(body),
      });
      let outcome = `http-${res.status}`;
      try { const j = await res.json(); if (j?.outcome) outcome = j.outcome; } catch { /* non-JSON */ }
      // 404 = the worker has the lane off (VISION_SWIFTUI unset): expected, not an error
      results.push({ png: shot.png, status: res.status, outcome: res.status === 404 ? 'off' : outcome });
    } catch (e) {
      results.push({ png: shot.png, status: 0, outcome: 'upload-error', error: e.message });
    }
  }
  return results;
}
