import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseExpectFiles,
  verifyExpectedFiles,
  decideTaskExit
} from "../plugins/codex/scripts/lib/expect-files.mjs";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "expect-files-test-"));
}

test("parseExpectFiles returns [] for empty, undefined, non-string", () => {
  assert.deepEqual(parseExpectFiles("", "/tmp"), []);
  assert.deepEqual(parseExpectFiles(undefined, "/tmp"), []);
  assert.deepEqual(parseExpectFiles(null, "/tmp"), []);
  assert.deepEqual(parseExpectFiles(42, "/tmp"), []);
});

test("parseExpectFiles splits comma list, trims, drops empties", () => {
  const tmp = mkTmp();
  const result = parseExpectFiles("a.md, b.md,,c.md  ", tmp);
  assert.equal(result.length, 3);
  for (const p of result) assert.ok(path.isAbsolute(p), `expected absolute: ${p}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("parseExpectFiles preserves already-absolute paths and normalizes", () => {
  const tmp = mkTmp();
  const abs = path.join(tmp, "deliverable.md");
  const result = parseExpectFiles(abs, "/wrong/cwd");
  assert.equal(result.length, 1);
  assert.equal(result[0], path.normalize(abs));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("parseExpectFiles accepts array form (repeated flag)", () => {
  const tmp = mkTmp();
  const result = parseExpectFiles(["a.md", "b.md,c.md"], tmp);
  assert.equal(result.length, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("parseExpectFiles handles paths containing spaces", () => {
  const tmp = mkTmp();
  const result = parseExpectFiles("has space.md", tmp);
  assert.equal(result.length, 1);
  assert.ok(result[0].endsWith("has space.md"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("verifyExpectedFiles empty list reports allPresent true", () => {
  assert.deepEqual(verifyExpectedFiles([]), { checked: [], allPresent: true });
  assert.deepEqual(verifyExpectedFiles(null), { checked: [], allPresent: true });
});

test("verifyExpectedFiles reports PRESENT with size for real files", () => {
  const tmp = mkTmp();
  const f = path.join(tmp, "r.md");
  fs.writeFileSync(f, "hello");
  const r = verifyExpectedFiles([f]);
  assert.equal(r.allPresent, true);
  assert.equal(r.checked[0].status, "PRESENT");
  assert.equal(r.checked[0].size, 5);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("verifyExpectedFiles reports MISSING with ENOENT", () => {
  const tmp = mkTmp();
  const missing = path.join(tmp, "nope.md");
  const r = verifyExpectedFiles([missing]);
  assert.equal(r.allPresent, false);
  assert.equal(r.checked[0].status, "MISSING");
  assert.equal(r.checked[0].error, "ENOENT");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("verifyExpectedFiles reports EMPTY for zero-byte files", () => {
  const tmp = mkTmp();
  const empty = path.join(tmp, "empty.md");
  fs.writeFileSync(empty, "");
  const r = verifyExpectedFiles([empty]);
  assert.equal(r.allPresent, false);
  assert.equal(r.checked[0].status, "EMPTY");
  assert.equal(r.checked[0].size, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("verifyExpectedFiles handles mixed PRESENT/EMPTY/MISSING", () => {
  const tmp = mkTmp();
  const present = path.join(tmp, "p.md");
  const empty = path.join(tmp, "e.md");
  const missing = path.join(tmp, "m.md");
  fs.writeFileSync(present, "x");
  fs.writeFileSync(empty, "");
  const r = verifyExpectedFiles([present, empty, missing]);
  assert.equal(r.allPresent, false);
  assert.equal(r.checked.length, 3);
  assert.equal(r.checked[0].status, "PRESENT");
  assert.equal(r.checked[1].status, "EMPTY");
  assert.equal(r.checked[2].status, "MISSING");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("decideTaskExit passthrough when no expect-files declared", () => {
  assert.equal(decideTaskExit(0, []).exitStatus, 0);
  assert.equal(decideTaskExit(1, []).exitStatus, 1);
  assert.equal(decideTaskExit(2, null).exitStatus, 2);
  assert.equal(decideTaskExit(0, []).verificationMessage, "");
});

test("decideTaskExit codex=0 files-present → exit 0 no message", () => {
  const tmp = mkTmp();
  const f = path.join(tmp, "ok.md");
  fs.writeFileSync(f, "ok");
  const r = decideTaskExit(0, [f]);
  assert.equal(r.exitStatus, 0);
  assert.equal(r.verificationMessage, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("decideTaskExit codex=1 files-present → exit 0 with override message", () => {
  const tmp = mkTmp();
  const f = path.join(tmp, "ok.md");
  fs.writeFileSync(f, "ok");
  const r = decideTaskExit(1, [f]);
  assert.equal(r.exitStatus, 0);
  assert.match(r.verificationMessage, /non-zero \(1\)/);
  assert.match(r.verificationMessage, /treating as success/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("decideTaskExit codex=0 files-missing → exit 1 with MISSING in message", () => {
  const tmp = mkTmp();
  const f = path.join(tmp, "gone.md");
  const r = decideTaskExit(0, [f]);
  assert.equal(r.exitStatus, 1);
  assert.match(r.verificationMessage, /not written/);
  assert.match(r.verificationMessage, /MISSING/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("decideTaskExit codex=2 files-empty → exit 2 preserved with EMPTY message", () => {
  const tmp = mkTmp();
  const f = path.join(tmp, "e.md");
  fs.writeFileSync(f, "");
  const r = decideTaskExit(2, [f]);
  assert.equal(r.exitStatus, 2);
  assert.match(r.verificationMessage, /EMPTY/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
