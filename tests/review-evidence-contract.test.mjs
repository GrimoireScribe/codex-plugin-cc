import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderReviewResult, auditGraphWitness } from "../plugins/codex/scripts/lib/render.mjs";
import { validate, isValid } from "./json-schema-mini.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "plugins", "codex", "schemas", "review-output.schema.json"), "utf8")
);

const META = { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" };

// A legitimately narrow fast-tier review: the diff WAS the whole review surface.
const DIFF_ONLY_CLEARANCE = {
  verdict: "approve",
  summary: "No blocking risk in the touched save path; the version guard holds.",
  review_evidence: {
    scope: "provided-diff-only",
    files_examined: ["src/lib/scenes.js"],
    checks_performed: [
      {
        check: "Stale-write rejection on concurrent scene save",
        evidence: ["scenes.js:139 rejects baseVersion < serverWriteSeq before the write"]
      }
    ],
    tools_used: [],
    limitations: []
  },
  findings: [],
  next_steps: []
};

const FULL_FINDING = {
  severity: "high",
  title: "Focus capture races React mount",
  body: "The focusin handler is installed after hydration, so the first focus event is lost.",
  file: "src/ui/FocusTrap.jsx",
  line_start: 42,
  line_end: 58,
  confidence: 0.8,
  severity_rationale: "Silently drops the first focus event for every keyboard user, with no error surfaced.",
  corrective_invariant: "A focusin listener must be installed before the first paint that can receive focus.",
  recommendation: "Move the capture to a native focusin listener installed before React mounts.",
  fix_confidence: "medium",
  trigger_conditions: "Ordinary — any keyboard user tabbing into the dialog on first render."
};

// --- Assertion 1: provided-diff-only clearance PASSES ------------------------------

test("assertion 1: provided-diff-only clearance is schema-valid and renders complete evidence", () => {
  assert.deepEqual(validate(SCHEMA, DIFF_ONLY_CLEARANCE), []);

  const output = renderReviewResult({ parsed: DIFF_ONLY_CLEARANCE, rawOutput: "", parseError: null }, META);

  assert.match(output, /## Review Evidence/);
  assert.match(output, /Scope: provided-diff-only/);
  assert.match(output, /src\/lib\/scenes\.js/);
  assert.match(output, /Stale-write rejection on concurrent scene save/);
  assert.match(output, /Evidence: scenes\.js:139 rejects baseVersion < serverWriteSeq/);
  assert.match(output, /Tools used: none/);
  assert.match(output, /Limitations: none recorded/);
  assert.match(output, /No material findings\./);
  // The fast-tier guard: a narrow scope must not be rendered as a deficiency.
  assert.doesNotMatch(output, /PLUGIN-EVIDENCE-WARNING/);
});

// --- Assertion 2: bare hollow approve FAILS ---------------------------------------

test("assertion 2: hollow approve is rejected by the schema", () => {
  const hollow = { verdict: "approve", summary: "looks safe", findings: [], next_steps: [] };
  const errors = validate(SCHEMA, hollow);
  assert.ok(errors.length > 0, "hollow approve must not validate");
  assert.match(errors.join("\n"), /missing required property `review_evidence`/);

  const emptyEvidence = {
    ...hollow,
    review_evidence: { scope: "provided-diff-only", files_examined: [], checks_performed: [], tools_used: [], limitations: [] }
  };
  const emptyErrors = validate(SCHEMA, emptyEvidence);
  assert.ok(emptyErrors.length > 0, "empty evidence arrays must not validate");
  assert.match(emptyErrors.join("\n"), /files_examined: array shorter than minItems 1/);
  assert.match(emptyErrors.join("\n"), /checks_performed: array shorter than minItems 1/);
});

test("assertion 2b: renderer refuses a payload with no review_evidence", () => {
  const output = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "looks safe", findings: [], next_steps: [] },
      rawOutput: '{"verdict":"approve"}',
      parseError: null
    },
    META
  );
  assert.match(output, /unexpected review shape/);
  assert.match(output, /Missing object `review_evidence`\./);
});

// --- Assertion 3: rendered doc exposes every per-finding field ----------------------

test("assertion 3: rendered document exposes all six per-finding fields", () => {
  const payload = {
    verdict: "needs-attention",
    summary: "One blocking focus bug; do not ship.",
    review_evidence: {
      scope: "targeted-repository",
      files_examined: ["src/ui/FocusTrap.jsx", "src/ui/Dialog.jsx"],
      checks_performed: [
        {
          check: "Listener install ordering relative to hydration",
          evidence: ["FocusTrap.jsx:42 installs the handler inside useEffect, after mount"]
        }
      ],
      tools_used: ["mcp__code-review-graph__get_impact_radius"],
      limitations: ["Did not exercise the change at runtime."]
    },
    findings: [FULL_FINDING],
    next_steps: ["Reinstall the focus listener before mount."]
  };

  assert.deepEqual(validate(SCHEMA, payload), []);

  const output = renderReviewResult({ parsed: payload, rawOutput: "", parseError: null }, META);

  assert.match(output, /## Review Evidence/);
  assert.match(output, /Confidence: 0\.8/);
  assert.match(output, /Severity rationale: Silently drops the first focus event/);
  assert.match(output, /Corrective invariant: A focusin listener must be installed before the first paint/);
  assert.match(output, /Recommendation: Move the capture to a native focusin listener/);
  assert.match(output, /Fix confidence: medium/);
  assert.match(output, /Trigger conditions: Ordinary/);
});

// --- Assertion 4: deep-tier graph witness -----------------------------------------

test("assertion 4: wider-scope claim with no graph call and no fallback is flagged", () => {
  const unwitnessed = {
    scope: "repository-wide",
    files_examined: ["src/lib/scenes.js"],
    checks_performed: [{ check: "Blast radius", evidence: ["scenes.js:139 is called from two flows"] }],
    tools_used: [],
    limitations: []
  };
  assert.equal(auditGraphWitness(unwitnessed).length, 1);

  const rendered = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "Wide sweep, nothing found.", review_evidence: unwitnessed, findings: [], next_steps: [] },
      rawOutput: "",
      parseError: null
    },
    META
  );
  assert.match(rendered, /PLUGIN-EVIDENCE-WARNING/);
  assert.match(rendered, /Treat the wider-scope claim as unwitnessed/);
});

test("assertion 4b: graph call or documented fallback satisfies the witness", () => {
  const withCall = {
    scope: "repository-wide",
    files_examined: ["src/lib/scenes.js"],
    checks_performed: [{ check: "Blast radius", evidence: ["get_impact_radius returned 2 downstream flows"] }],
    tools_used: ["mcp__code-review-graph__get_impact_radius"],
    limitations: []
  };
  assert.deepEqual(auditGraphWitness(withCall), []);

  const withFallback = {
    ...withCall,
    tools_used: [],
    limitations: ["Graph MCP tools were unavailable; fell back to targeted grep and file reads."]
  };
  assert.deepEqual(auditGraphWitness(withFallback), []);

  // A narrow scope makes no wider claim, so it is never flagged.
  assert.deepEqual(auditGraphWitness(DIFF_ONLY_CLEARANCE.review_evidence), []);
});

// --- Guard: the mismatch the template used to demand but the schema could not carry ---

test("per-finding contract fields are required by the schema", () => {
  const findingSchema = SCHEMA.properties.findings.items;
  for (const field of ["severity_rationale", "corrective_invariant", "recommendation", "fix_confidence", "trigger_conditions", "confidence"]) {
    assert.ok(findingSchema.required.includes(field), `finding schema must require \`${field}\``);
    assert.ok(findingSchema.properties[field], `finding schema must define \`${field}\``);
  }
  assert.equal(findingSchema.properties.confidence.type, "number");
  assert.equal(findingSchema.additionalProperties, false);
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(SCHEMA.properties.review_evidence.additionalProperties, false);
  assert.equal(SCHEMA.properties.review_evidence.properties.checks_performed.items.additionalProperties, false);

  // Dropping any one required per-finding field must fail validation.
  for (const field of findingSchema.required) {
    const { [field]: _omitted, ...partial } = FULL_FINDING;
    assert.ok(
      !isValid(SCHEMA, { ...DIFF_ONLY_CLEARANCE, verdict: "needs-attention", findings: [partial] }),
      `finding missing \`${field}\` must be rejected`
    );
  }
});
