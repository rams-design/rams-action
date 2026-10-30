// RAMS-461: the render lane edits the customer's checkout (wrappers appended
// to changed files, the renderer to the @main file). The journal makes the
// restore unconditional: every original is copied to a temp dir BEFORE the
// first write, and restore() runs on success, on a throw, on SIGINT/SIGTERM
// (a cancelled job), and on an uncaught exception. Restores are synchronous
// so they finish before the process exits.
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * @param root repo root
 * @param opts.proc  process-like (on/off/exit), injectable for tests
 * @param opts.log   where a signal restore reports
 */
export function createJournal(root, { proc = process, log = (m) => console.error(m) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rams-journal-'));
  const index = []; // { file, slot }
  const originals = new Map(); // file -> Buffer
  let restored = false;

  /** The original bytes of f, journaled to disk on first sight. */
  function touch(file) {
    if (!originals.has(file)) {
      const buf = readFileSync(join(root, file));
      const slot = String(index.length);
      writeFileSync(join(dir, slot), buf);
      index.push({ file, slot });
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ root, files: index }));
      originals.set(file, buf);
    }
    return originals.get(file);
  }

  /** Original + appended text, written only after the original is journaled. */
  function append(file, text) {
    const orig = touch(file);
    writeFileSync(join(root, file), Buffer.concat([orig, Buffer.from(text, 'utf8')]));
  }

  /** Put every journaled original back, from the copies on disk. Sync, idempotent per call. */
  function restore() {
    const failed = [];
    for (const { file, slot } of index) {
      try { copyFileSync(join(dir, slot), join(root, file)); } catch (e) { failed.push(`${file}: ${e.message}`); }
    }
    restored = true;
    return failed;
  }

  const onSignal = (sig) => {
    const failed = restore();
    log(`rams-render: ${sig}, restored ${index.length - failed.length}/${index.length} file(s)${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}`);
    proc.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onCrash = (err) => {
    const failed = restore();
    log(`rams-render: crashed (${err?.message ?? err}), restored ${index.length - failed.length}/${index.length} file(s)`);
    proc.exit(1);
  };
  const handlers = [['SIGINT', onSignal], ['SIGTERM', onSignal], ['uncaughtException', onCrash]];
  for (const [ev, fn] of handlers) proc.on(ev, fn);

  /** Restore, unhook, and delete the journal. */
  function close() {
    const failed = restore();
    for (const [ev, fn] of handlers) proc.off(ev, fn);
    if (!failed.length) rmSync(dir, { recursive: true, force: true });
    return failed;
  }

  return { dir, touch, append, restore, close, get files() { return index.map((x) => x.file); }, get restored() { return restored; } };
}
