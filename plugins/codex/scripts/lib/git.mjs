import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

// Commit-range review support (2026-08-10). PO's standing rule for multi-commit ships is
// to pass `FIRST^..HEAD` to every reviewer; before this, `--commit` validated with a bare
// `rev-parse --verify`, so a range exited 1 and PO fell back to a single SHA — leaving the
// second commit of a 2-commit ship unreviewed by Codex while Gemini saw the full range.
// Git refnames cannot contain "..", so the presence of a two/three-dot separator is an
// unambiguous range signal and single SHAs keep their existing path untouched.
const COMMIT_RANGE_PATTERN = /^(.+?)(\.{2,3})(.+)$/;

function parseCommitRangeSyntax(ref) {
  const match = COMMIT_RANGE_PATTERN.exec(String(ref).trim());
  if (!match) {
    return null;
  }
  const [, left, dots, right] = match;
  return { left: left.trim(), dots, right: right.trim() };
}

function resolveCommitEndpoint(cwd, endpoint, rangeRef) {
  // `^{commit}` rejects trees, blobs, and annotated-tag-to-non-commit peels, so a
  // syntactically valid but non-commit endpoint fails closed instead of producing a
  // nonsense diff.
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${endpoint}^{commit}`]);
  const sha = result.status === 0 ? result.stdout.trim() : "";
  if (!sha) {
    throw new Error(
      `Invalid commit range "${rangeRef}": "${endpoint}" does not resolve to a commit in this repository.`
    );
  }
  return sha;
}

// `--` stops git from resolving a revision argument against a same-named working-tree
// path ("fatal: ambiguous argument '<A>..<B>': both revision and filename"). `--no-relative`
// defeats `diff.relative=true`, which otherwise scopes the diff to the cwd and can make a
// perfectly good range look empty when the command runs from a subdirectory.
function diffRevisionArgs(revisions) {
  return ["--no-relative", ...revisions, "--"];
}

// The empty tree is the only sane base for a root commit's diff. Let git compute the id
// instead of hardcoding 4b825dc642cb6eb9a060e54bf8d69288fbee4904 — that is the SHA-1
// value and it is a different object id in a SHA-256 repository, so the constant would
// break exactly where it is hardest to notice.
function getEmptyTreeSha(cwd) {
  return gitChecked(cwd, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).stdout.trim();
}

// Counts `parent` header lines on the raw commit object.
//
// This must NOT be done with `rev-parse <sha>^` or `rev-list --max-parents=0`: in a
// shallow clone the graft hides a boundary commit's parents from the revision walk, so
// both report a real commit as parentless. Treating that as a root commit would diff it
// against the empty tree and hand the reviewer whole files as if the commit had created
// them — a silent wrong answer where git previously failed loudly. The commit object
// itself still carries the true parent headers, so read those.
function readCommitParents(cwd, sha) {
  const body = gitChecked(cwd, ["cat-file", "-p", `${sha}^{commit}`]).stdout;
  const parents = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) {
      break; // headers end at the first blank line; the message follows
    }
    if (line.startsWith("parent ")) {
      parents.push(line.slice("parent ".length).trim());
    }
  }
  return parents;
}

function commitObjectExists(cwd, sha) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).status === 0;
}

// Resolves what a single commit should be diffed against, distinguishing a true root
// commit (empty tree) from a shallow-clone boundary commit (hard error).
function resolveCommitDiffBase(cwd, sha, displayRef) {
  const parents = readCommitParents(cwd, sha);
  if (parents.length === 0) {
    return { base: getEmptyTreeSha(cwd), isRoot: true, parents };
  }
  const firstParent = parents[0];
  if (!commitObjectExists(cwd, firstParent)) {
    throw new Error(
      `Commit "${displayRef}" sits on the boundary of a shallow clone: its parent ${firstParent} is not available locally, so its diff cannot be computed. Run \`git fetch --deepen <n>\` (or \`--unshallow\`) and retry.`
    );
  }
  return { base: firstParent, isRoot: false, parents };
}

// Fails closed on every degenerate range: unknown endpoints, identical endpoints,
// reversed endpoints, divergent two-dot endpoints, unrelated histories, shallow-clone
// boundaries, and any range whose net diff is empty. An empty or misattributed review
// target must never silently produce an "approve with no findings".
//
// What the canonical form does and does NOT guarantee:
//
// It DOES stop `git log` and `git diff` from being asked different questions. Left alone
// they disagree in two ways, and both hand the reviewer a diff that no listed commit
// produced:
//   - `A...B`: log is the symmetric difference (both sides), diff is merge-base(A,B)..B.
//   - `A..B` with divergent endpoints: log lists only B's commits, but diff also reverts
//     A's unique work, so the reviewer sees deletions no listed commit performed.
// Both are resolved by reducing every accepted range to `<diffBase>..<rightSha>`, which
// log and diff agree on. Divergent two-dot ranges are rejected and redirected to
// three-dot; unrelated histories are rejected outright.
//
// It does NOT make every listed commit visible in the diff, and it cannot: a combined
// range diff is by definition the NET effect of the range. A change introduced by one
// commit and reverted by a later one inside the same range is correctly absent from the
// net diff while both commits still appear in the log. That is git's semantics, not a
// bug, but it is misleading if the reviewer is not told — so the commit list is annotated
// per-commit and the section carries an explicit net-effect note. See
// collectCommitRangeContext.
function resolveCommitRange(cwd, commitRef) {
  const parsed = parseCommitRangeSyntax(commitRef);
  if (!parsed) {
    return null;
  }

  const { left, right, dots } = parsed;
  // Normalize away surrounding whitespace so every downstream git invocation uses the
  // exact string whose endpoints were validated here.
  const range = `${left}${dots}${right}`;
  const symmetric = dots === "...";
  const rightSha = resolveCommitEndpoint(cwd, right, range);

  // `ROOT^..HEAD` is PO's standing form applied to a repository's first ship, where the
  // left endpoint cannot resolve because the root commit has no parent. Rather than
  // failing on the one shape the standing rule guarantees, treat "<root>^" as the empty
  // tree. Only a TRUE root qualifies — resolveCommitDiffBase rejects a shallow-clone
  // boundary commit instead of silently pretending it created every file it touches.
  const parentSuffix = /^(.+?)(?:\^|~1)$/.exec(left);
  let rootBaseSha = "";
  if (parentSuffix && git(cwd, ["rev-parse", "--verify", "--quiet", `${left}^{commit}`]).status !== 0) {
    const candidate = git(cwd, ["rev-parse", "--verify", "--quiet", `${parentSuffix[1]}^{commit}`]);
    if (candidate.status === 0) {
      const candidateSha = candidate.stdout.trim();
      const { base, isRoot } = resolveCommitDiffBase(cwd, candidateSha, left);
      // "<X> is a root, so the empty tree is the right base" only holds when X is the
      // ONLY root reachable from the right endpoint. A repository can have several —
      // `git subtree add`, a merged-in orphan branch, an imported repo. In that case the
      // empty tree silently expands the range to the ENTIRE repository and every commit
      // in it, including history that predates the ship. Baseline failed loudly here;
      // turning that into a silently over-scoped review is the exact failure class the
      // rest of this resolver exists to prevent.
      if (isRoot) {
        const roots = gitChecked(cwd, ["rev-list", "--max-parents=0", rightSha, "--"])
          .stdout.trim()
          .split("\n")
          .filter(Boolean);
        if (roots.length === 1 && roots[0] === candidateSha) {
          rootBaseSha = base;
        }
      }
    }
  }

  const leftSha = rootBaseSha || resolveCommitEndpoint(cwd, left, range);

  let diffBase;
  if (rootBaseSha) {
    // Empty tree -> right: every commit up to and including right is in the range.
    diffBase = rootBaseSha;
  } else {
    if (leftSha === rightSha) {
      throw new Error(`Invalid commit range "${range}": both endpoints resolve to the same commit (empty diff).`);
    }

    const leftIsAncestor = git(cwd, ["merge-base", "--is-ancestor", leftSha, rightSha]).status === 0;
    const rightIsAncestor = git(cwd, ["merge-base", "--is-ancestor", rightSha, leftSha]).status === 0;
    if (!leftIsAncestor && rightIsAncestor) {
      throw new Error(
        `Invalid commit range "${range}": endpoints are reversed. "${right}" is an ancestor of "${left}" — use "${right}${dots}${left}".`
      );
    }

    if (symmetric) {
      // Three-dot: the diff is merge-base(A,B)..B, so the commit list must be too.
      const mergeBase = git(cwd, ["merge-base", leftSha, rightSha]);
      const mergeBaseSha = mergeBase.status === 0 ? mergeBase.stdout.trim() : "";
      if (!mergeBaseSha) {
        throw new Error(
          `Invalid commit range "${range}": "${left}" and "${right}" have no common ancestor, so there is no range to review.`
        );
      }
      diffBase = mergeBaseSha;
    } else if (!leftIsAncestor) {
      throw new Error(
        `Invalid commit range "${range}": "${left}" and "${right}" have diverged, so the two-dot diff would also revert work unique to "${left}" that no commit in the range performed. Use "${left}...${right}" to review only the commits unique to "${right}".`
      );
    } else {
      diffBase = leftSha;
    }
  }

  // Every downstream git invocation uses these resolved SHAs, not the user's string, so
  // the commit log and the diff cannot be asked different questions.
  const isRootRange = Boolean(rootBaseSha);
  const diffRevisions = isRootRange ? [diffBase, rightSha] : [`${diffBase}..${rightSha}`];
  const logRevisions = isRootRange ? [rightSha] : [`${diffBase}..${rightSha}`];
  // The reviewer is told to go collect the diff itself on the lightweight path, so this
  // string has to be a RUNNABLE git invocation. Git special-cases the empty tree only at
  // its full object id — an abbreviated empty-tree id does not resolve — so a root range
  // must not be abbreviated, and the two-argument form is used rather than `A..B`.
  const displayRange = isRootRange
    ? `${diffBase} ${rightSha.slice(0, 12)}`
    : `${diffBase.slice(0, 12)}..${rightSha.slice(0, 12)}`;
  const reviewCommand = `Diffed as \`git diff ${displayRange}\``;

  const changedFiles = gitChecked(cwd, ["diff", "--name-only", ...diffRevisionArgs(diffRevisions)]).stdout.trim();
  if (!changedFiles) {
    const commitCount = gitChecked(cwd, ["rev-list", "--count", ...logRevisions, "--"]).stdout.trim();
    const cause =
      commitCount === "0"
        ? "the range contains no commits"
        : `its ${commitCount} commit(s) leave no net change (an empty commit, or work introduced and reverted within the range)`;
    throw new Error(`Invalid commit range "${range}": ${cause}, so there is nothing to review.`);
  }

  return {
    range,
    diffRevisions,
    logRevisions,
    displayRange,
    reviewCommand,
    isRootRange,
    left,
    right,
    dots,
    leftSha,
    rightSha,
    diffBase
  };
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  // Only `commitRange` is used. A second, differently-scoped range string sitting next to
  // it is a trap waiting to be picked up by mistake, so it is not kept here.
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

// Resolves a single `--commit <sha>` target. Root commits diff against the empty tree
// instead of dying on `<sha>^`, shallow-clone boundaries fail loudly rather than
// pretending the commit created every file it touches, and a commit with no net change
// is rejected rather than producing a silent empty review.
function resolveSingleCommit(cwd, commitRef) {
  const sha = gitChecked(cwd, ["rev-parse", "--verify", `${commitRef}^{commit}`]).stdout.trim();
  const { base, isRoot, parents } = resolveCommitDiffBase(cwd, sha, commitRef);
  const diffRevisions = [base, sha];
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", ...diffRevisionArgs(diffRevisions)]).stdout.trim();

  if (!changedFiles) {
    // An ordinary --no-ff merge has a NON-empty first-parent diff, so this fires only on
    // the narrow cases (`-s ours`, or a side branch already applied to the mainline).
    // Say so explicitly — a bare "changes no files" on a merge SHA reads as a tool bug.
    if (parents.length > 1) {
      throw new Error(
        `Commit "${commitRef}" is a merge commit that changes nothing relative to its first parent, so there is nothing to review. To review the merged-in work, pass a range such as --commit ${base.slice(0, 12)}..${parents[1].slice(0, 12)}.`
      );
    }
    throw new Error(`Commit "${commitRef}" changes no files, so there is nothing to review.`);
  }

  return { sha, base, isRoot, parents, diffRevisions };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const commitRef = options.commit ?? null;
  if (commitRef) {
    // Resolve against the repo root, not the caller's cwd. `git diff` honors
    // `diff.relative`, which scopes output to the current directory — from a subdirectory
    // that makes a perfectly good range look empty and wrongly rejects it. The
    // working-tree and branch paths were always immune because they probe at the root.
    const repoRoot = getRepoRoot(cwd);
    const range = resolveCommitRange(repoRoot, commitRef);
    if (range) {
      return {
        mode: "commit-range",
        label: `commit range ${range.range}`,
        commitRange: range.range,
        range,
        explicit: true
      };
    }
    const commit = resolveSingleCommit(repoRoot, commitRef);
    return {
      mode: "commit",
      label: `commit ${commitRef}`,
      commitRef,
      commit,
      explicit: true
    };
  }

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref> / --commit <sha>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedSummary(paths) {
  if (!paths.length) {
    return "(none)";
  }
  return paths.join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const includeUntrackedContents = options.includeUntrackedContents !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = includeUntrackedContents
      ? state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n")
      : formatUntrackedSummary(state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = includeUntrackedContents
      ? state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n")
      : formatUntrackedSummary(state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", ...diffRevisionArgs([comparison.commitRange])]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange, "--"]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", ...diffRevisionArgs([comparison.commitRange])]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...diffRevisionArgs([comparison.commitRange])]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function collectCommitContext(cwd, commitRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const commit = options.commit ?? resolveSingleCommit(cwd, commitRef);
  const diffArgs = diffRevisionArgs(commit.diffRevisions);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", ...diffArgs]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", "-1", commitRef, "--"]).stdout.trim();
  const commitMessage = gitChecked(cwd, ["log", "--format=%B", "-1", commitRef, "--"]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", ...diffArgs]).stdout.trim();

  return {
    mode: "commit",
    summary: commit.isRoot
      ? `Reviewing commit ${commitRef} (the repository's root commit, diffed against the empty tree).`
      : `Reviewing commit ${commitRef}.`,
    content: includeDiff
      ? [
          formatSection("Commit", logOutput),
          formatSection("Commit Message", commitMessage),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Commit Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...diffArgs]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit", logOutput),
          formatSection("Commit Message", commitMessage),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    commitRef
  };
}

// One `git show` per commit, and the review can walk this path TWICE — collectReviewContext
// runs again on the prompt-size fallback — so the measured cost doubles in the worst case
// (~4s per 60 commits here, so ~13s at this cap, ~26s across both runs). Past this many
// commits the marks are not computed, and the note says so rather than leaving their
// absence to be misread as "nothing was undone".
const MAX_ANNOTATED_RANGE_COMMITS = 100;

// A combined range diff is the NET effect of the range, so a commit whose changes were
// reverted later inside the same range appears in the log with nothing to show for it in
// the diff. Silently listing it invites the reviewer to believe it reviewed that commit.
// Annotate those commits explicitly instead.
//
// Both probes MUST run with --no-renames. Rename detection is on by default and the two
// sides of this comparison see different paths: the net diff reports only a rename's
// DESTINATION path, while `git show` on an earlier commit reports the path as it existed
// THEN. Without --no-renames, "commit X edits auth.js" + "commit Y renames auth.js to
// authentication.js" makes X's file set disjoint from the net set, and X is branded as
// contributing nothing while its change sits in the diff under the new name. That is
// strictly worse than the omission this annotation exists to fix: the original bug left
// the reviewer neutral, the false positive makes an affirmative claim about the exact
// commit that matters and steers the reviewer away from it. Renaming a file in the same
// range that changes it is ordinary work, not a corner case.
//
// The oracle's file set is computed here rather than reusing the review's own changed-file
// list, so the user-visible "Changed Files" section keeps rename detection and only this
// comparison uses the no-renames view.
function annotateNetEffect(cwd, logOutput, diffArgs, commitCount) {
  if (!logOutput || commitCount > MAX_ANNOTATED_RANGE_COMMITS) {
    return logOutput;
  }
  const netProbe = git(cwd, ["diff", "--name-only", "--no-renames", ...diffArgs]);
  if (netProbe.status !== 0) {
    return logOutput; // cannot compute the oracle; annotate nothing rather than guess
  }
  const netFiles = new Set(netProbe.stdout.trim().split("\n").filter(Boolean));

  return logOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const sha = line.split(/\s/, 1)[0];
      if (!sha) {
        return line;
      }
      const touched = git(cwd, ["show", "--pretty=format:", "--name-only", "--no-renames", sha, "--"]);
      if (touched.status !== 0) {
        return line;
      }
      const files = touched.stdout.trim().split("\n").filter(Boolean);
      if (!files.length) {
        // `git show` prints no file list for a merge commit, so an empty list is "cannot
        // tell" there and must not be read as "contributed nothing". For an ordinary
        // commit an empty list really is definitive. Gate on parent count, not on the
        // empty list alone.
        let parentCount = 2;
        try {
          parentCount = readCommitParents(cwd, sha).length;
        } catch {
          return line;
        }
        if (parentCount > 1) {
          return line;
        }
      } else if (files.some((file) => netFiles.has(file))) {
        return line;
      }
      // Describes exactly what was checked — file paths — not what was inferred. A note
      // whose job is to prevent overclaiming must not itself overclaim.
      return `${line}  [no file this commit touched appears in the combined diff below]`;
    })
    .join("\n");
}

function collectCommitRangeContext(cwd, range, options = {}) {
  const includeDiff = options.includeDiff !== false;
  // Resolved SHAs, never the user's raw string — see resolveCommitRange for why log and
  // diff must be asked the same question.
  const diffArgs = diffRevisionArgs(range.diffRevisions);
  const logArgs = [...range.logRevisions, "--"];
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", ...diffArgs]).stdout.trim().split("\n").filter(Boolean);
  const rawLog = gitChecked(cwd, ["log", "--oneline", "--decorate", ...logArgs]).stdout.trim();
  const commitCount = rawLog ? rawLog.split("\n").filter(Boolean).length : 0;
  const logOutput = annotateNetEffect(cwd, rawLog, diffArgs, commitCount);
  const commitMessages = gitChecked(cwd, ["log", "--format=%h %B%n---", ...logArgs]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", ...diffArgs]).stdout.trim();
  const target = includeDiff ? "the combined diff below" : "the combined diff (not inlined here)";
  const annotated = commitCount <= MAX_ANNOTATED_RANGE_COMMITS;
  const netEffectNote = [
    `(${range.reviewCommand}.`,
    `That diff is the NET effect of all ${commitCount} commit(s), not a replay of each one:`,
    "work introduced and then reverted within this range is correctly absent from it.",
    annotated
      ? `An annotated commit is one where no file it touched appears in ${target}; that check compares FILE PATHS only, so a commit whose changes were only PARTIALLY undone later is NOT annotated — its file still appears while some of its hunks do not.`
      : `This range exceeds ${MAX_ANNOTATED_RANGE_COMMITS} commits, so per-commit contribution marks were NOT computed: the absence of a mark here means nothing was checked, not that nothing was undone.`,
    "Do not treat the commit list as proof that every listed commit's changes are present.",
    "If a commit matters to a finding, check it directly with `git show <sha>`.)"
  ].join(" ");

  return {
    mode: "commit-range",
    summary: `Reviewing commit range ${range.range} (${commitCount} commit(s), diffed as ${range.displayRange}) as one combined diff.`,
    content: includeDiff
      ? [
          formatSection("Commits In Range", `${netEffectNote}\n\n${logOutput}`),
          formatSection("Commit Messages", commitMessages),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Combined Range Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...diffArgs]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commits In Range", `${netEffectNote}\n\n${logOutput}`),
          formatSection("Commit Messages", commitMessages),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    commitRange: range.range
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "commit") {
    // Re-resolve when the target was hand-built: without the validated revisions a root
    // commit dies on `<sha>^` and a shallow boundary silently diffs against nothing.
    const commit = target.commit?.diffRevisions ? target.commit : resolveSingleCommit(repoRoot, target.commitRef);
    const diffArgs = diffRevisionArgs(commit.diffRevisions);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", ...diffArgs]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...diffArgs],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectCommitContext(repoRoot, target.commitRef, { includeDiff, commit });
  } else if (target.mode === "commit-range") {
    // Re-resolve rather than trusting a hand-built target: without validated revisions
    // the log and the diff can describe different commits.
    const range = target.range?.diffRevisions ? target.range : resolveCommitRange(repoRoot, target.commitRange);
    const diffArgs = diffRevisionArgs(range.diffRevisions);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", ...diffArgs]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...diffArgs],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectCommitRangeContext(repoRoot, range, { includeDiff });
  } else if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff,
      includeUntrackedContents: options.includeUntrackedContents ?? includeDiff
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", ...diffRevisionArgs([comparison.commitRange])]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...diffRevisionArgs([comparison.commitRange])],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
