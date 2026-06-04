import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMcpReviewPrompt,
  buildAdversarialReviewPrompt,
  FAST_TIER_EXPLORATION,
  DEEP_TIER_EXPLORATION
} from "../plugins/codex/scripts/codex-companion.mjs";

// Minimal review context shaped like collectReviewContext() output. inputMode
// "inline-diff" is the case where fast-tier pre-scoping must kick in (the diff is
// inlined, so the model must NOT go exploring the repo). "self-collect" is the
// large-diff fallback where the exploratory prompt must be retained.
function makeContext(inputMode) {
  return {
    inputMode,
    target: { label: "working tree diff" },
    collectionGuidance: "(collection guidance)",
    content: "(diff and changed files)"
  };
}

test("code-review path: fast tier on inline diff is pre-scoped (no repo-wide exploration)", () => {
  const prompt = buildMcpReviewPrompt(makeContext("inline-diff"), "", { fastTier: true });
  assert.ok(
    prompt.includes(FAST_TIER_EXPLORATION),
    "fast-tier code review on an inline diff must use the bounded exploration block"
  );
  assert.ok(
    !prompt.includes(DEEP_TIER_EXPLORATION),
    "fast-tier code review must NOT use the deep-tier graph-fan-out block"
  );
});

test("code-review path: deep tier keeps full graph-first exploration", () => {
  const prompt = buildMcpReviewPrompt(makeContext("inline-diff"), "", { fastTier: false });
  assert.ok(
    prompt.includes(DEEP_TIER_EXPLORATION),
    "deep-tier code review must keep the graph-first exploration block"
  );
  assert.ok(!prompt.includes(FAST_TIER_EXPLORATION));
});

test("code-review path: fast tier on self-collect keeps exploratory prompt (nothing inlined)", () => {
  const prompt = buildMcpReviewPrompt(makeContext("self-collect"), "", { fastTier: true });
  assert.ok(
    prompt.includes(DEEP_TIER_EXPLORATION),
    "self-collect has no inlined diff, so the model must be allowed to explore"
  );
  assert.ok(!prompt.includes(FAST_TIER_EXPLORATION));
});

test("adversarial path: fast tier on inline diff is still pre-scoped (regression guard)", () => {
  const prompt = buildAdversarialReviewPrompt(makeContext("inline-diff"), "", { fastTier: true });
  assert.ok(prompt.includes(FAST_TIER_EXPLORATION));
  assert.ok(!prompt.includes(DEEP_TIER_EXPLORATION));
});

test("no unresolved template placeholders remain in either builder", () => {
  for (const inputMode of ["inline-diff", "self-collect"]) {
    for (const fastTier of [true, false]) {
      const mcp = buildMcpReviewPrompt(makeContext(inputMode), "", { fastTier });
      const adv = buildAdversarialReviewPrompt(makeContext(inputMode), "", { fastTier });
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(mcp), `unresolved placeholder in mcp prompt (${inputMode}/${fastTier})`);
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(adv), `unresolved placeholder in adv prompt (${inputMode}/${fastTier})`);
    }
  }
});
