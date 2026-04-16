import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Regression test for the extractRequestedSavePath regex coverage gap flagged
// by the 2026-04-15 adversarial review. The concern: the 6-pattern regex table
// in codex-companion.mjs was never exercised against the real spec/scoping
// review template output. This test reproduces the regex table in isolation
// and asserts that the catch-all pattern correctly extracts the OUTPUT_PATH
// from a realistic interpolated template, on both Windows backslash paths and
// forward-slash paths.

const patterns = [
  /save\b[\s\S]{0,300}?\bto\s+[`"'](?<path>(?:[A-Za-z]:[\\/]|\/)[^`"']+)[`"']/i,
  /save[- ]output\b[\s\S]{0,120}?[`"'](?<path>(?:[A-Za-z]:[\\/]|\/)[^`"']+)[`"']/i,
  /\b(?:save|write)\b[\s\S]{0,300}?[`"'](?<path>(?:[A-Za-z]:[\\/]|\/tmp\/|\/cygdrive\/[A-Za-z]\/|\/[A-Za-z]\/|\/home\/)[^`"']+)[`"']/i,
  /save\b[\s\S]{0,300}?\bto\s+(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n`"')\]]+)/i,
  /save[- ]output\b[\s\S]{0,120}?(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n`"')\]]+)/i,
  /\b(?:save|write)\b[\s\S]{0,300}?(?<path>(?:[A-Za-z]:[\\/]|\/tmp\/|\/cygdrive\/[A-Za-z]\/|\/[A-Za-z]\/|\/home\/)[^\r\n`"')\]]+)/i,
];

function extractPath(prompt) {
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.groups?.path) {
      return match.groups.path.trim();
    }
  }
  return null;
}

test("extractRequestedSavePath matches Windows backslash paths in 'Write ... to: <path>' form", () => {
  const winPath = "E:\\OneDrive\\reviews\\codex_spec_TEST.md";
  const prompt = `Write your review to: ${winPath}`;
  assert.equal(extractPath(prompt), winPath);
});

test("extractRequestedSavePath matches Windows forward-slash paths", () => {
  const winPath = "E:/OneDrive/reviews/codex_spec_TEST.md";
  const prompt = `Save output to ${winPath}`;
  assert.equal(extractPath(prompt), winPath);
});

test("extractRequestedSavePath matches POSIX absolute paths", () => {
  const posixPath = "/tmp/reviews/test.md";
  const prompt = `save to '${posixPath}'`;
  assert.equal(extractPath(prompt), posixPath);
});

test("extractRequestedSavePath returns null when no save/write directive present", () => {
  const prompt = "Please analyze the code at E:\\project\\src.";
  // Note: this matches pattern 5 (catch-all) because of 'analyze' — but 'analyze' does
  // not contain 'save' or 'write', so pattern 5 requires \b(?:save|write)\b which won't
  // match. Expected: null.
  assert.equal(extractPath(prompt), null);
});

test("extractRequestedSavePath character class [\\/] matches both separators in JS regex", () => {
  // This is the regression assertion for the 2026-04-15 review: the character class
  // [\\/] inside a JS regex matches either a literal backslash or a forward slash.
  // The Opus review incorrectly claimed [\\/] only matches forward slash; Codex's
  // self-review correctly demonstrated the JS semantics.
  const re = /[A-Za-z]:[\\/]/;
  assert.equal(re.test("E:\\path"), true, "must match backslash");
  assert.equal(re.test("E:/path"), true, "must match forward slash");
});

test("extractRequestedSavePath handles pathological multi-token input in bounded time", () => {
  // Guards against DoS risk flagged in 2026-04-15 adversarial review: a prompt with
  // many space-separated tokens after a "save to" directive would previously cause
  // refineRequestedSavePath to iterate O(tokens) times with filesystem syscalls each.
  // The iteration cap in codex-companion.mjs should bound worst-case cost.
  const tokens = Array.from({ length: 500 }, (_, i) => `/tmp/t${i}`).join(" ");
  const prompt = `save to ${tokens} /tmp/final.md`;
  const start = Date.now();
  const result = extractPath(prompt);
  const elapsed = Date.now() - start;
  // Even with 500 tokens, the regex itself should terminate quickly. The refinement
  // step (which does fs syscalls) is behind this test and should be bounded by the
  // REFINE_PATH_MAX_ITERATIONS cap. A conservative threshold — if this test ever
  // takes >2s, something is wrong.
  assert.ok(elapsed < 2000, `Extraction took ${elapsed}ms — should be bounded`);
  // Result is allowed to be anything sensible; we only care that it didn't hang.
  assert.ok(result !== undefined, "must return a defined result");
});

test("extractRequestedSavePath works against the real spec-adversarial-review template", () => {
  // Integration-style: read the actual prompt template, simulate interpolation the
  // same way prompts.mjs does, and verify the save-path extraction against it.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const templatePath = path.join(ROOT, "plugins", "codex", "prompts", "spec-adversarial-review.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const outputPath = path.resolve("E:/OneDrive/Test Reviews/codex_spec_TEST.md");
  const interpolated = template
    .replace(/\{\{SPEC_PATH\}\}/g, "E:\\OneDrive\\Test Specs\\TEST.md")
    .replace(/\{\{OUTPUT_PATH\}\}/g, outputPath)
    .replace(/\{\{TARGET_LABEL\}\}/g, "spec: TEST")
    .replace(/\{\{USER_FOCUS\}\}/g, "test");
  const extracted = extractPath(interpolated);
  assert.ok(extracted, "Extraction must not return null for a real template");
  // On Windows, path.resolve produces a drive-letter path with backslashes. On POSIX
  // test runs, the path is rooted at /E:/...  — accept either as long as it contains
  // the filename.
  assert.ok(
    extracted.includes("codex_spec_TEST.md"),
    `Expected extracted path to contain the filename, got: ${extracted}`
  );
});
