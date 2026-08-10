import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = path.join(ROOT, "plugins", "codex", "prompts");

// Every review prompt carries a first-party authorization preamble. Codex's content
// filter killed a PM#1902 review of a security LINTER — the reviewer saw code that scans
// for capability/security patterns and refused, treating our own defensive tooling as
// suspicious. Any security-hardening ticket can re-trip that on any provider with safety
// filtering.
//
// This test exists because the feature fails SILENTLY GREEN: delete the block from a
// template and nothing else in the suite notices, while every future security review is
// exposed again. Enumerating the directory rather than a hardcoded list means a NEW
// review prompt is also caught the moment it is added unframed.
const REQUIRED_TAG = "<review_context_and_authorization>";

function listPromptFiles() {
  return fs
    .readdirSync(PROMPTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

test("every review prompt template carries the security-review preamble", () => {
  const files = listPromptFiles();
  assert.ok(files.length >= 5, `expected the review prompt templates to still be present, saw ${files.length}`);

  const missing = files.filter((name) => {
    const body = fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
    return !body.includes(REQUIRED_TAG);
  });

  assert.deepEqual(
    missing,
    [],
    `these review prompts are missing ${REQUIRED_TAG} and will re-trip the content filter on security work`
  );
});

test("the preamble asserts first-party ownership without lowering the review bar", () => {
  for (const name of listPromptFiles()) {
    const body = fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
    const start = body.indexOf(REQUIRED_TAG);
    const end = body.indexOf("</review_context_and_authorization>");
    assert.ok(start !== -1 && end > start, `${name}: preamble block is malformed`);
    const block = body.slice(start, end);

    // The framing must be about OUR code being reviewed, not about producing tooling.
    assert.match(block, /our own/i, `${name}: preamble must assert first-party ownership`);
    assert.match(block, /defensive/i, `${name}: preamble must name the work as defensive engineering`);
    // And it must not read as permission to go easy — that would be a worse outcome than
    // the filter trip it exists to prevent.
    assert.match(block, /same rigor/i, `${name}: preamble must preserve review rigor`);
    assert.match(
      block,
      /do not decline, soften, redact, or abbreviate/i,
      `${name}: preamble must forbid softening the review`
    );
  }
});
