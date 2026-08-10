import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { collectReviewContext, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("git wrappers force shell: false after the caller options spread", () => {
  // Behavioral detection is masked by the quoteShellArg layer in process.mjs, so the
  // no-shell guarantee is asserted directly against the wrapper source: shell: false
  // must appear after ...options so no caller can override it.
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "lib", "git.mjs"),
    "utf8"
  );
  assert.match(source, /runCommand\("git", args, \{ cwd, \.\.\.options, shell: false \}\)/);
  assert.match(source, /runCommandChecked\("git", args, \{ cwd, \.\.\.options, shell: false \}\)/);
});

test("every revision-taking git diff routes through the -- / --no-relative guard", () => {
  // Two failure modes are only reachable in environments awkward to build in a unit test,
  // so the guarantee is asserted against the source the way the shell: false rule is.
  //
  // 1. ENAMETOOLONG. git stat()s a bare revision argument to disambiguate revision from
  //    path. When repo_path + 1 + range_string exceeds the platform limit (260 on
  //    Windows) the stat fails and git ABORTS rather than falling back to revision
  //    parsing: "fatal: failed to stat '<A>..<B>': Filename too long". A SHA-256 repo has
  //    130-char ranges, so any checkout deeper than ~130 chars trips it — ordinary for
  //    OneDrive paths and nested CI checkouts. Reproduced at a 132-char path: bare token
  //    aborts, `--` succeeds.
  // 2. diff.relative=true scopes the diff to the cwd, which can make a valid range look
  //    empty and get it wrongly rejected. `--no-relative` defeats it.
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "lib", "git.mjs"),
    "utf8"
  );
  assert.match(
    source,
    /function diffRevisionArgs\(revisions\) \{\s*return \["--no-color", "--no-relative", \.\.\.revisions, "--"\];/
  );

  // Every `git diff` / `git log` invocation must either go through the helper or end with
  // an explicit `--`. This is an ALLOWLIST, not a heuristic: gating on revision-looking
  // variable names would silently stop checking a call site the moment someone renames a
  // variable, which is exactly when the guarantee needs checking.
  const ALLOWED_UNTERMINATED = [
    // Working-tree diffs take no revision at all, so there is nothing to disambiguate.
    // They still carry --no-color: color.ui=always would otherwise inject ANSI escape
    // sequences into the diff text embedded in the review prompt.
    '["diff", "--no-color", "--cached", "--name-only"]',
    '["diff", "--no-color", "--name-only"]',
    '["diff", "--no-color", "--shortstat", "--cached"]',
    '["diff", "--no-color", "--shortstat"]',
    '["diff", "--no-color", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]',
    '["diff", "--no-color", "--binary", "--no-ext-diff", "--submodule=diff"]'
  ];

  // Nothing may emit color into the prompt: every git verb that renders diff or log text
  // must disable it explicitly, since color.ui=always overrides the not-a-tty default.
  const colorless = [];
  for (const match of source.replace(/\s*\n\s*/g, " ").match(/\[\s*"(diff|log|show)"[^\]]*\]/g) ?? []) {
    const call = match.replace(/\s+/g, " ");
    const inheritsGuard = call.includes("diffRevisionArgs") || call.includes("...diffArgs");
    if (!call.includes("--no-color") && !call.includes("--pretty=format:") && !inheritsGuard) {
      colorless.push(call);
    }
  }
  assert.deepEqual(colorless, [], "these git calls render text without --no-color");

  // Call sites may also spread a pre-built argument array. That is only safe if the array
  // itself was built with the guard, so each such name is pinned to its construction
  // below — renaming one breaks these assertions rather than silently disabling the scan.
  assert.match(source, /const diffArgs = diffRevisionArgs\(/);
  assert.match(source, /const logArgs = \[\.\.\.range\.logRevisions, "--"\];/);
  const PREBUILT_ARG_NAMES = ["...diffArgs", "...logArgs"];

  // Scan the source with newlines collapsed. A line-by-line scan silently misses a call
  // split across lines, which is the shape a formatter produces the moment an argument
  // list gets long — the scan would keep passing while the guarantee rotted.
  const flat = source.replace(/\s*\n\s*/g, " ");

  // Every verb that disambiguates a revision from a path is covered, not just diff/log.
  // `show` and `rev-list` take revisions too and are equally exposed to ENAMETOOLONG.
  const REVISION_VERBS = /\[\s*"(diff|log|show|rev-list)"[^\]]*\]/g;

  const offenders = [];
  const usedAllowances = new Set();
  for (const match of flat.match(REVISION_VERBS) ?? []) {
    const call = match.replace(/\s+/g, " ");
    if (/diffRevisionArgs/.test(call)) {
      continue;
    }
    if (PREBUILT_ARG_NAMES.some((name) => call.includes(name))) {
      continue;
    }
    const allowance = ALLOWED_UNTERMINATED.find((entry) => call.includes(entry));
    if (allowance) {
      usedAllowances.add(allowance);
      continue;
    }
    if (/"--"\s*\]/.test(call)) {
      continue;
    }
    offenders.push(call);
  }
  assert.deepEqual(
    offenders,
    [],
    "these git calls take a revision without the -- / --no-relative guard"
  );

  // A literal-verb scan cannot see `[verb, ...]` where verb is computed. Rather than
  // pretend otherwise, require every git argument list in this module to START with a
  // string literal, so the scan above provably sees all of them.
  const computed = (flat.match(/\bgit(?:Checked)?\(\s*[A-Za-z_$][\w$.]*\s*,\s*\[\s*[^"\s\]]/g) ?? []).map((entry) =>
    entry.trim()
  );
  assert.deepEqual(
    computed,
    [],
    "git argument lists must begin with a literal verb so the revision-guard scan can see them"
  );

  // A stale allowlist entry is itself a hole: it would keep silently excusing a call
  // shape that no longer exists while a real one slips past unnoticed.
  const stale = ALLOWED_UNTERMINATED.filter((entry) => !usedAllowances.has(entry));
  assert.deepEqual(stale, [], "these allowlist entries no longer match any call site and must be removed");
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

// --- Commit range review support -------------------------------------------------

// NOTE: helpers.run spawns with shell: true on Windows, so commit messages must stay
// single-word — a multi-word -m argument is concatenated unquoted and git reads the
// trailing words as pathspecs, silently producing no commit.
function initTwoCommitChain(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 'v0';\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, "first.js"), "export const first = 'FIRST_COMMIT_MARKER';\n");
  run("git", ["add", "first.js"], { cwd });
  run("git", ["commit", "-m", "first"], { cwd });
  fs.writeFileSync(path.join(cwd, "second.js"), "export const second = 'SECOND_COMMIT_MARKER';\n");
  run("git", ["add", "second.js"], { cwd });
  run("git", ["commit", "-m", "second"], { cwd });
  return {
    base: run("git", ["rev-parse", "HEAD~2"], { cwd }).stdout.trim(),
    first: run("git", ["rev-parse", "HEAD~1"], { cwd }).stdout.trim(),
    head: run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim()
  };
}

test("resolveReviewTarget keeps single-SHA commit review unchanged", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: shas.head });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit");
  assert.equal(target.commitRef, shas.head);
  assert.equal(target.label, `commit ${shas.head}`);
  assert.match(context.content, /## Commit Diff/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
  // The single-SHA path must still see ONLY that commit.
  assert.doesNotMatch(context.content, /FIRST_COMMIT_MARKER/);
});

test("resolveReviewTarget reviews FIRST^..HEAD as one combined range diff", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.first}^..HEAD` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.equal(target.commitRange, `${shas.first}^..HEAD`);
  assert.equal(target.label, `commit range ${shas.first}^..HEAD`);
  assert.equal(context.fileCount, 2);
  assert.match(context.summary, /2 commit\(s\)/);
  assert.match(context.content, /## Combined Range Diff/);
  // Both commits' changes must be visible to the reviewer — the coverage hole this fixes.
  assert.match(context.content, /FIRST_COMMIT_MARKER/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
});

test("resolveReviewTarget accepts an explicit two-dot SHA range", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.base}..${shas.head}` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /FIRST_COMMIT_MARKER/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
});

test("resolveReviewTarget accepts a three-dot range", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.base}...${shas.head}` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.equal(target.commitRange, `${shas.base}...${shas.head}`);
  assert.match(context.content, /FIRST_COMMIT_MARKER/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
});

// Builds two branches that diverged from a shared base:
//   main:    base -> MAIN_ONLY_MARKER      (branch "main")
//   feature: base -> FEATURE_ONLY_MARKER   (branch "feature/test", checked out)
function initDivergentBranches(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 'v0';\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const base = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  fs.writeFileSync(path.join(cwd, "main-only.js"), "export const m = 'MAIN_ONLY_MARKER';\n");
  run("git", ["add", "main-only.js"], { cwd });
  run("git", ["commit", "-m", "mainonly"], { cwd });
  const main = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "-b", "feature/test", base], { cwd });
  fs.writeFileSync(path.join(cwd, "feature-only.js"), "export const f = 'FEATURE_ONLY_MARKER';\n");
  run("git", ["add", "feature-only.js"], { cwd });
  run("git", ["commit", "-m", "featureonly"], { cwd });
  const feature = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  return { base, main, feature };
}

test("three-dot range never lists a commit whose changes are absent from the diff", () => {
  // `git log A...B` is the symmetric difference while `git diff A...B` is
  // merge-base(A,B)..B. Driving both from the user's raw string would advertise the
  // left branch's commit in "Commits In Range" while its code never appears in the
  // diff — the exact partial-coverage hole this feature exists to close.
  const cwd = makeTempDir();
  const shas = initDivergentBranches(cwd);

  const target = resolveReviewTarget(cwd, { commit: `main...${shas.feature}` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.match(context.summary, /1 commit\(s\)/);
  assert.match(context.content, /FEATURE_ONLY_MARKER/);
  assert.doesNotMatch(context.content, /MAIN_ONLY_MARKER/);
  assert.doesNotMatch(context.content, /mainonly/);
  assert.match(context.content, /featureonly/);
});

test("resolveReviewTarget rejects a divergent two-dot range", () => {
  // `git diff A..B` across diverged branches also reverts A's unique work, which no
  // commit listed by `git log A..B` performed. Reject and point at the three-dot form.
  const cwd = makeTempDir();
  const shas = initDivergentBranches(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `main..${shas.feature}` }),
    /have diverged/
  );
});

test("resolveReviewTarget rejects a range across unrelated histories", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "--orphan", "orphan"], { cwd });
  fs.writeFileSync(path.join(cwd, "other.js"), "export const value = 'other';\n");
  run("git", ["add", "other.js"], { cwd });
  run("git", ["commit", "-m", "orphan"], { cwd });
  const orphan = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${first}...${orphan}` }),
    /no common ancestor/
  );
});

test("resolveReviewTarget falls back to lightweight context for large ranges", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.first}^..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 1 });

  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /## Changed Files/);
  assert.doesNotMatch(context.content, /FIRST_COMMIT_MARKER/);
});

test("resolveReviewTarget rejects a range with an unknown endpoint", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..${shas.head}` }),
    /does not resolve to a commit/
  );
  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${shas.base}..deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` }),
    /does not resolve to a commit/
  );
});

test("resolveReviewTarget rejects a range whose endpoints are identical", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${shas.head}..HEAD` }),
    /same commit \(empty diff\)/
  );
});

test("resolveReviewTarget rejects a reversed range", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${shas.head}..${shas.base}` }),
    /endpoints are reversed/
  );
});

test("resolveReviewTarget rejects a range that changes no files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // An empty commit advances HEAD without touching any file: a range over it is a
  // real range with a real endpoint but nothing to review.
  run("git", ["commit", "--allow-empty", "-m", "empty"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: "HEAD^..HEAD" }),
    /leave no net change/
  );
});

test("resolveReviewTarget names the cause when a range's commits cancel out", () => {
  // A real fix cycle that nets to zero (change, then revert) must not be reported as
  // "no commits" — the reviewer's operator needs to know the commits exist but cancel.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v2';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  run("git", ["revert", "--no-edit", first], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${first}^..HEAD` }),
    /2 commit\(s\) leave no net change/
  );
});

test("commit range annotates a commit whose changes are undone later in the range", () => {
  // The combined diff is the NET effect of the range, so a commit reverted inside the
  // range legitimately has nothing in the diff. It still appears in the commit list, so
  // it must be labelled — otherwise the reviewer believes it reviewed that commit.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 'v0';\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, "risky.js"), "export const bypass = 'BAD_AUTH_BYPASS';\n");
  run("git", ["add", "risky.js"], { cwd });
  run("git", ["commit", "-m", "risky"], { cwd });
  const risky = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  fs.rmSync(path.join(cwd, "risky.js"));
  fs.writeFileSync(path.join(cwd, "safe.js"), "export const safe = 'SAFE_MARKER';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "fix"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${risky}^..HEAD` });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /SAFE_MARKER/);
  // The risky commit's content is genuinely absent from the net diff...
  assert.doesNotMatch(context.content, /BAD_AUTH_BYPASS/);
  // ...so the commit list must say so rather than implying it was reviewed.
  assert.match(context.content, /no file this commit touched appears/);
  assert.match(context.content, /NET effect/);
});

test("a renamed file does not make the commit that changed it look uncovered", () => {
  // Rename detection is ON by default and the two sides of the annotation oracle see
  // different paths: the net diff reports only a rename's DESTINATION, while `git show`
  // on the earlier commit reports the path as it existed THEN. Without --no-renames on
  // both probes, the commit that introduced the code is branded "no net contribution"
  // while its change sits in the diff under the new name — an affirmative false claim
  // steering the reviewer away from the exact commit that matters.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "auth.js"), "export const ok = true;\n");
  run("git", ["add", "auth.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, "auth.js"), "export const ok = true;\nexport const bypass = 'AUTH_BYPASS';\n");
  run("git", ["add", "auth.js"], { cwd });
  run("git", ["commit", "-m", "bypass"], { cwd });
  const bypass = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  run("git", ["mv", "auth.js", "authentication.js"], { cwd });
  run("git", ["commit", "-m", "rename"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${bypass}^..HEAD` });
  const context = collectReviewContext(cwd, target);

  // The bypass really is in the combined diff, under the new name.
  assert.match(context.content, /AUTH_BYPASS/);
  // So nothing in this range may be annotated as contributing nothing.
  assert.doesNotMatch(context.content, /no file this commit touched appears/);
});

test("the net-effect note discloses that marks were computed", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 1;\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "one"], { cwd });
  fs.writeFileSync(path.join(cwd, "b.js"), "export const b = 2;\n");
  run("git", ["add", "b.js"], { cwd });
  run("git", ["commit", "-m", "two"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { commit: `${first}^..HEAD` }));

  // The identifier handed to the reviewer must be a runnable git invocation.
  assert.match(context.content, /Diffed as `git diff [0-9a-f]+\.\.[0-9a-f]+`/);
  assert.match(context.content, /compares FILE PATHS only/);
  assert.doesNotMatch(context.content, /marks were NOT computed/);
});

test("a merge commit is never annotated on missing evidence", () => {
  // `git show` prints no file list for a merge, so an empty list is "cannot tell" there
  // and must not be read as "contributed nothing".
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 0;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const base = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  run("git", ["checkout", "-b", "side"], { cwd });
  fs.writeFileSync(path.join(cwd, "side.js"), "export const side = 'SIDE_MARKER';\n");
  run("git", ["add", "side.js"], { cwd });
  run("git", ["commit", "-m", "side"], { cwd });
  run("git", ["checkout", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "main2.js"), "export const m = 2;\n");
  run("git", ["add", "main2.js"], { cwd });
  run("git", ["commit", "-m", "main2"], { cwd });
  run("git", ["merge", "--no-ff", "side", "-m", "merged"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${base}..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 5 });

  assert.match(context.content, /SIDE_MARKER/);
  assert.doesNotMatch(context.content, /no file this commit touched appears/);
});

test("a conflict-resolved merge is never annotated on its partial --cc file list", () => {
  // `git show` on a merge renders the dense-combined (--cc) view, which lists ONLY files
  // differing from EVERY parent. A clean merge yields an empty list; a conflict-resolved
  // merge yields a small PARTIAL one. Gating on the empty list alone let the partial case
  // through, branding a merge as contributing nothing while it was the sole reason a file
  // was in the combined diff.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "orig\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const base = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "-b", "side"], { cwd });
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "a\n");
  fs.writeFileSync(path.join(cwd, "side.js"), "export const s = 'MERGE_CARRIED_MARKER';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "sidework"], { cwd });

  run("git", ["checkout", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "x\n");
  fs.writeFileSync(path.join(cwd, "main2.js"), "export const m = 2;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "mainwork"], { cwd });

  run("git", ["merge", "side", "-m", "evilmerge"], { cwd }); // conflicts
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "EVIL\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "--no-edit"], { cwd });
  const mergeSha = run("git", ["rev-parse", "--short", "HEAD"], { cwd }).stdout.trim();
  // Restore the conflicted file so its path drops out of the net diff. This makes the
  // merge's partial --cc list (conflict.txt) disjoint from the net file set.
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "orig\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "restore"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${base}..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 10 });

  // The merge is the only reason the side work is in the combined diff...
  assert.match(context.content, /MERGE_CARRIED_MARKER/);
  assert.match(context.content, /Merge commits are never annotated/);
  // ...so the MERGE line specifically must carry no mark. (The later "restore" commit is
  // legitimately annotated — its own change really is absent from the net diff.)
  const mergeLine = context.content
    .split("\n")
    .find((line) => line.startsWith(mergeSha) || line.includes(` ${mergeSha} `));
  assert.ok(mergeLine, `expected the merge commit ${mergeSha} in the commit list`);
  assert.doesNotMatch(mergeLine, /no file this commit touched appears/);
});

test("the mainline root still supports ROOT^..HEAD in a repository with a second root", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "main1.js"), "export const a = 'MAINLINE_FIRST';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "mainroot"], { cwd });
  const mainRoot = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "--orphan", "imported"], { cwd });
  run("git", ["rm", "-rf", "."], { cwd });
  fs.writeFileSync(path.join(cwd, "vendor.js"), "export const v = 'VENDORED';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "secondroot"], { cwd });
  const secondRoot = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "main"], { cwd });
  run("git", ["merge", "--allow-unrelated-histories", "imported", "-m", "mergeimport"], { cwd });

  // The mainline root's parent legitimately means "everything from the beginning".
  const target = resolveReviewTarget(cwd, { commit: `${mainRoot}^..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 50 });
  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /MAINLINE_FIRST/);

  // A merged-in root's parent must be refused, naming the real cause.
  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${secondRoot}^..HEAD` }),
    /merged into this history/
  );
});

test("annotation marks survive color.ui=always", () => {
  // Without --no-color the sha token becomes an ANSI-wrapped string, every per-commit
  // lookup fails, and the marks silently vanish while the note still claims they exist.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  run("git", ["config", "color.ui", "always"], { cwd });
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 0;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, "risky.js"), "export const r = 'COLOR_BYPASS_MARKER';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "risky"], { cwd });
  const risky = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  fs.rmSync(path.join(cwd, "risky.js"));
  fs.writeFileSync(path.join(cwd, "safe.js"), "export const s = 1;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "fix"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${risky}^..HEAD` });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /no file this commit touched appears/);
  // And no raw escape codes leak into the prompt.
  assert.doesNotMatch(context.content, /\[/);
});

test("a second root in the repository does not silently expand ROOT^..HEAD to everything", () => {
  // "<X> is a root, so use the empty tree" only holds when X is the ONLY root reachable
  // from the right endpoint. With a merged-in orphan branch (git subtree, imported repo)
  // the empty tree expands the range to the entire repository and all of its history.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "old1.js"), "export const old = 'PREDATES_THE_SHIP';\n");
  run("git", ["add", "old1.js"], { cwd });
  run("git", ["commit", "-m", "old1"], { cwd });
  fs.writeFileSync(path.join(cwd, "old2.js"), "export const old2 = 2;\n");
  run("git", ["add", "old2.js"], { cwd });
  run("git", ["commit", "-m", "old2"], { cwd });

  run("git", ["checkout", "--orphan", "imported"], { cwd });
  run("git", ["rm", "-rf", "."], { cwd });
  fs.writeFileSync(path.join(cwd, "imported.js"), "export const imported = 1;\n");
  run("git", ["add", "imported.js"], { cwd });
  run("git", ["commit", "-m", "secondroot"], { cwd });
  const secondRoot = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "main"], { cwd });
  run("git", ["merge", "--allow-unrelated-histories", "imported", "-m", "mergeimport"], { cwd });
  fs.writeFileSync(path.join(cwd, "followup.js"), "export const f = 1;\n");
  run("git", ["add", "followup.js"], { cwd });
  run("git", ["commit", "-m", "followup"], { cwd });

  // Must NOT quietly review the whole repository as if the second root were THE root.
  // Asserted on the specific rejection, not "threw for some reason" — a try/catch that
  // returns early would keep passing if a future edit made every range throw.
  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${secondRoot}^..HEAD` }),
    /merged into this history rather than the root/
  );
});

test("commit range resolves correctly when invoked from a subdirectory", () => {
  // `git diff` honors diff.relative, which scopes output to the cwd. Probing the range
  // anywhere but the repo root made a valid range look empty and rejected it.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  run("git", ["config", "diff.relative", "true"], { cwd });
  fs.mkdirSync(path.join(cwd, "top"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "sub", "keep.js"), "export const keep = 1;\n");
  fs.writeFileSync(path.join(cwd, "top", "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "top", "app.js"), "export const value = 'SUBDIR_MARKER';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  const subdir = path.join(cwd, "sub");
  const target = resolveReviewTarget(subdir, { commit: `${first}^..HEAD` });
  const context = collectReviewContext(subdir, target);

  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /SUBDIR_MARKER/);
});

test("resolveReviewTarget rejects a range endpoint that is not a commit", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);
  const treeSha = run("git", ["rev-parse", "HEAD^{tree}"], { cwd }).stdout.trim();

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${treeSha}..${shas.head}` }),
    /does not resolve to a commit/
  );
});

test("resolveReviewTarget rejects malformed range syntax without silently reviewing nothing", () => {
  const cwd = makeTempDir();
  initTwoCommitChain(cwd);

  // Assert on the error itself, not just "something threw". `..HEAD` and `HEAD..` are
  // not recognized as ranges at all, so they fall through to the legacy single-ref path
  // and surface git's own rev-parse failure; the rest are rejected as bad ranges. Both
  // are acceptable outcomes, but the test must be able to tell them apart.
  const expected = [
    ["..HEAD", /rev-parse|Not a valid object name|unknown revision|ambiguous/i],
    ["HEAD..", /rev-parse|Not a valid object name|unknown revision|ambiguous/i],
    ["HEAD....HEAD", /Invalid commit range/],
    ["HEAD..nope..HEAD", /Invalid commit range/]
  ];

  for (const [bad, pattern] of expected) {
    assert.throws(
      () => resolveReviewTarget(cwd, { commit: bad }),
      (error) => {
        assert.ok(error instanceof Error, `"${bad}" must throw an Error`);
        assert.match(error.message, pattern, `"${bad}" threw an unexpected message`);
        return true;
      }
    );
  }
});

test("single-SHA review of a root commit diffs against the empty tree", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'ROOT_COMMIT_MARKER';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const root = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  const target = resolveReviewTarget(cwd, { commit: root });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit");
  assert.match(context.summary, /root commit/);
  assert.match(context.content, /ROOT_COMMIT_MARKER/);
});

test("ROOT^..HEAD reviews a first ship instead of failing on the missing parent", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 'FIRST_SHIP_A';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "one"], { cwd });
  const root = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  fs.writeFileSync(path.join(cwd, "b.js"), "export const b = 'FIRST_SHIP_B';\n");
  run("git", ["add", "b.js"], { cwd });
  run("git", ["commit", "-m", "two"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${root}^..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 5 });

  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /FIRST_SHIP_A/);
  assert.match(context.content, /FIRST_SHIP_B/);
});

test("a shallow-clone boundary commit is refused, not treated as a root commit", () => {
  // `rev-parse <sha>^` and `rev-list --max-parents=0` are both fooled by the graft: they
  // report a real commit as parentless. Treating it as a root would diff it against the
  // empty tree and present whole files as newly created — a silent wrong answer where
  // git previously failed loudly.
  const origin = makeTempDir();
  initGitRepo(origin);
  fs.writeFileSync(path.join(origin, "app.js"), "line1\n");
  run("git", ["add", "app.js"], { cwd: origin });
  run("git", ["commit", "-m", "one"], { cwd: origin });
  fs.writeFileSync(path.join(origin, "app.js"), "line1\nSHALLOW_ADDED_LINE\n");
  run("git", ["add", "app.js"], { cwd: origin });
  run("git", ["commit", "-m", "two"], { cwd: origin });

  const clone = path.join(makeTempDir(), "shallow");
  const originUrl = `file:///${origin.replace(/\\/g, "/")}`;
  const cloneResult = run("git", ["clone", "--depth", "1", originUrl, clone], { cwd: origin });
  if (cloneResult.status !== 0) {
    return; // shallow clone unsupported in this environment; nothing to assert
  }

  // Precondition: the clone really is shallow, and both of the oracles one would reach
  // for first are fooled by the graft — `rev-parse HEAD^` happily returns the parent SHA
  // read out of the commit header even though that object is absent, and
  // `rev-list --max-parents=0` names the boundary commit as the root.
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], { cwd: clone }).stdout.trim(), "true");
  const head = run("git", ["rev-parse", "HEAD"], { cwd: clone }).stdout.trim();
  assert.equal(run("git", ["rev-parse", "--verify", "HEAD^"], { cwd: clone }).status, 0);
  assert.equal(run("git", ["rev-list", "--max-parents=0", "-n1", "HEAD"], { cwd: clone }).stdout.trim(), head);

  assert.throws(
    () => resolveReviewTarget(clone, { commit: "HEAD" }),
    /shallow clone/
  );
});

test("single-SHA review of an ordinary merge commit still works", () => {
  // The empty-diff guard must not reject ordinary merges: a --no-ff merge of a diverged
  // branch has a NON-empty first-parent diff.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 0;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["checkout", "-b", "side"], { cwd });
  fs.writeFileSync(path.join(cwd, "side.js"), "export const side = 'MERGED_SIDE_MARKER';\n");
  run("git", ["add", "side.js"], { cwd });
  run("git", ["commit", "-m", "side"], { cwd });
  run("git", ["checkout", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "main2.js"), "export const m = 2;\n");
  run("git", ["add", "main2.js"], { cwd });
  run("git", ["commit", "-m", "main2"], { cwd });
  run("git", ["merge", "--no-ff", "side", "-m", "merged"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: "HEAD" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit");
  assert.match(context.content, /MERGED_SIDE_MARKER/);
});

test("a merge commit with no net first-parent change is refused with merge-specific guidance", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 0;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["checkout", "-b", "side"], { cwd });
  fs.writeFileSync(path.join(cwd, "side.js"), "export const side = 1;\n");
  run("git", ["add", "side.js"], { cwd });
  run("git", ["commit", "-m", "side"], { cwd });
  run("git", ["checkout", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "main2.js"), "export const m = 2;\n");
  run("git", ["add", "main2.js"], { cwd });
  run("git", ["commit", "-m", "main2"], { cwd });
  run("git", ["merge", "-s", "ours", "side", "-m", "oursmerge"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: "HEAD" }),
    /merge commit that changes nothing/
  );
});

test("single-SHA review of an empty commit is refused instead of reviewing nothing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["commit", "--allow-empty", "-m", "empty"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: "HEAD" }),
    /changes no files/
  );
});

test("collectReviewContext re-resolves a hand-built commit-range target", () => {
  // A target carrying only `commitRange` (no validated `range`) must not fall back to
  // driving log and diff from the raw user string.
  const cwd = makeTempDir();
  const shas = initDivergentBranches(cwd);

  const context = collectReviewContext(cwd, {
    mode: "commit-range",
    label: `commit range main...${shas.feature}`,
    commitRange: `main...${shas.feature}`,
    explicit: true
  });

  assert.match(context.content, /FEATURE_ONLY_MARKER/);
  assert.doesNotMatch(context.content, /MAIN_ONLY_MARKER/);
});
