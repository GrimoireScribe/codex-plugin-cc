import fs from "node:fs";
import path from "node:path";

export function parseExpectFiles(raw, cwd) {
  const base = cwd || process.cwd();
  const parts = [];
  const pushList = (value) => {
    if (typeof value !== "string") return;
    for (const piece of value.split(",").map((p) => p.trim()).filter(Boolean)) {
      parts.push(piece);
    }
  };
  if (Array.isArray(raw)) {
    for (const item of raw) pushList(item);
  } else {
    pushList(raw);
  }
  return parts.map((p) => path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p));
}

export function verifyExpectedFiles(expectFiles) {
  if (!Array.isArray(expectFiles) || expectFiles.length === 0) {
    return { checked: [], allPresent: true };
  }
  const checked = [];
  let allPresent = true;
  for (const target of expectFiles) {
    let exists = false;
    let size = 0;
    let error = null;
    try {
      const stat = fs.statSync(target);
      exists = true;
      size = stat.size;
    } catch (e) {
      error = e?.code === "ENOENT" ? "ENOENT" : (e?.code || "ERROR");
    }
    const empty = exists && size === 0;
    const status = !exists ? "MISSING" : empty ? "EMPTY" : "PRESENT";
    if (!exists || empty) allPresent = false;
    checked.push({ path: target, status, exists, size, error });
  }
  return { checked, allPresent };
}

export function decideTaskExit(codexExit, expectFiles) {
  const expected = verifyExpectedFiles(expectFiles);
  if (!Array.isArray(expectFiles) || expectFiles.length === 0) {
    return { exitStatus: codexExit, verificationMessage: "", expected };
  }
  if (expected.allPresent) {
    return {
      exitStatus: 0,
      verificationMessage:
        codexExit !== 0
          ? `Codex exited non-zero (${codexExit}) but all expected files are present; treating as success.`
          : "",
      expected
    };
  }
  const missing = expected.checked
    .filter((c) => c.status !== "PRESENT")
    .map((c) => `${c.status}: ${c.path}`)
    .join("; ");
  return {
    exitStatus: codexExit !== 0 ? codexExit : 1,
    verificationMessage: `Expected deliverables not written: ${missing}`,
    expected
  };
}
