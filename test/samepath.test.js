'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The local->local transfer branch computes dstPath from dst.dir + basename(src).
// Dropping a file back into its own parent folder makes dstPath === srcResolved,
// which the server guards against. These tests pin both the guard condition and
// the data-loss it prevents.

test('dropping into own parent dir yields dstPath === srcResolved (guard fires)', () => {
  const srcResolved = path.resolve('/home/u/data/report.txt');
  const dstDir = path.resolve(path.dirname(srcResolved)); // same folder
  const dstPath = path.join(dstDir, path.basename(srcResolved));
  assert.strictEqual(dstPath, srcResolved);
});

test('dropping into a different dir does NOT collide (guard stays out of the way)', () => {
  const srcResolved = path.resolve('/home/u/data/report.txt');
  const dstDir = path.resolve('/home/u/backup');
  const dstPath = path.join(dstDir, path.basename(srcResolved));
  assert.notStrictEqual(dstPath, srcResolved);
});

test('copying a file onto itself is never a valid transfer (throws or truncates)', () => {
  // Node's fs.cpSync rejects identical paths (ERR_FS_CP_EINVAL); the remote
  // relay path instead opens-for-write then reads, emptying the file. Either
  // way, src === dst must never reach the transfer engine — hence the guard.
  const f = path.join(os.tmpdir(), `webscp-selfcopy-${process.pid}.txt`);
  fs.writeFileSync(f, 'important payload');
  try {
    let emptiedOrThrew = false;
    try {
      fs.cpSync(f, f, { recursive: true });
      emptiedOrThrew = fs.readFileSync(f, 'utf8') === '';
    } catch {
      emptiedOrThrew = true;
    }
    assert.ok(emptiedOrThrew, 'self-copy must not be a safe no-op');
  } finally {
    fs.rmSync(f, { force: true });
  }
});
