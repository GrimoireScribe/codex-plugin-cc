// Authorship contract (Owner directive, 2026-09-05).
//
// PM#2027: a provider issued `fail` on a Medium finding the commit did not create, and the
// judge had to revert the diff to prove the behavior was pre-existing. The provider prompts
// carried no notion of introduced vs pre-existing, so every defect visible in the diff read
// as one the commit caused. The rule now: a pre-existing defect the change did not
// introduce, worsen, or newly expose is NOT a finding against the commit, and can never
// drive a blocking verdict.
//
// The three layers must move together or the classification vanishes on the wire — schema
// carries it, prompt demands it, renderer discloses it. Each layer is asserted here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderReviewResult } from "../plugins/codex/scripts/lib/render.mjs";
import { validate, isValid } from "./json-schema-mini.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(HERE, "..", "plugins", "codex");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "schemas", "review-output.schema.json"), "utf8"));

const META = { reviewLabel: "Adversarial Review", targetLabel: "commit abc1234" };

const EVIDENCE = {
  scope: "provided-diff-only",
  files_examined: ["src/ui/SceneEditor.jsx"],
  checks_performed: [
    {
      check: "Confirm-dialog teardown on a failed save",
      evidence: ["SceneEditor.jsx:212 leaves `confirmOpen` true when the save promise rejects"]
    }
  ],
  tools_used: [],
  limitations: []
};

function finding(overrides = {}) {
  return {
    severity: "medium",
    title: "Confirm dialog is not dismissed on HTTP 503",
    body: "A rejected save leaves the modal mounted with no path back.",
    file: "src/ui/SceneEditor.jsx",
    line_start: 212,
    line_end: 218,
    confidence: 0.7,
    severity_rationale: "The user is trapped in a modal until a full reload.",
    corrective_invariant: "Every save-promise rejection must clear `confirmOpen`.",
    recommendation: "Clear `confirmOpen` in a `finally` block around the save call.",
    fix_confidence: "high",
    trigger_conditions: "Ordinary — confirm a scene save while the backend returns 503.",
    authorship: "introduced",
    authorship_evidence: "The `+` hunk at SceneEditor.jsx:212 adds the confirm path; no equivalent existed at abc1234^.",
    exposure: "not-applicable",
    exposure_evidence: "",
    ...overrides
  };
}

function payload(overrides = {}) {
  return {
    verdict: "needs-attention",
    summary: "One blocking issue in the touched save path.",
    review_evidence: EVIDENCE,
    findings: [finding()],
    pre_existing_observations: [],
    next_steps: [],
    ...overrides
  };
}

function render(overrides = {}) {
  return renderReviewResult({ parsed: payload(overrides), rawOutput: "", parseError: null }, META);
}

// --- Layer 1: the schema carries the classification -------------------------------

test("schema requires authorship, authorship_evidence and exposure on every finding", () => {
  const findingSchema = SCHEMA.properties.findings.items;
  for (const field of ["authorship", "authorship_evidence", "exposure", "exposure_evidence"]) {
    assert.ok(findingSchema.required.includes(field), `finding schema must require \`${field}\``);
    assert.ok(findingSchema.properties[field], `finding schema must define \`${field}\``);

    const { [field]: _omitted, ...partial } = finding();
    assert.ok(!isValid(SCHEMA, payload({ findings: [partial] })), `finding missing \`${field}\` must be rejected`);
  }
});

test("authorship and exposure enums carry exactly the directed vocabularies", () => {
  const props = SCHEMA.properties.findings.items.properties;
  assert.deepEqual(props.authorship.enum, ["introduced", "pre-existing", "unverified"]);
  // `not-applicable` is this plugin's addition: OpenAI strict structured outputs demand
  // every property appear in `required`, so `exposure` cannot be omitted the way the other
  // providers omit it. The sentinel is how a non-pre-existing finding says "does not apply".
  assert.deepEqual(props.exposure.enum, ["change-touches-property", "untouched", "not-applicable"]);
  // `exposure_evidence` carries "" in that same case, so it must not enforce minLength.
  assert.equal(props.exposure_evidence.minLength, undefined);

  // A value outside the vocabulary must die at the wire, not render as a classification.
  assert.ok(!isValid(SCHEMA, payload({ findings: [finding({ authorship: "probably-ours" })] })));
  assert.ok(!isValid(SCHEMA, payload({ findings: [finding({ exposure: "maybe" })] })));
});

test("pre_existing_observations is a required top-level array of {file, line, note}", () => {
  assert.ok(SCHEMA.required.includes("pre_existing_observations"));
  const items = SCHEMA.properties.pre_existing_observations.items;
  // This object shape is shared across providers so PO-side dedup sees one shape.
  assert.deepEqual(items.required, ["file", "line", "note"]);
  assert.equal(items.properties.line.type, "integer");
  assert.equal(items.additionalProperties, false);

  const { pre_existing_observations: _omitted, ...withoutSection } = payload();
  assert.match(validate(SCHEMA, withoutSection).join("|"), /missing required property `pre_existing_observations`/);

  assert.ok(
    !isValid(SCHEMA, payload({ pre_existing_observations: ["src/ui/SceneEditor.jsx:212 - already there."] })),
    "a bare string is no longer the observation shape"
  );
  assert.ok(
    !isValid(SCHEMA, payload({ pre_existing_observations: [{ file: "a.js", note: "x" }] })),
    "an observation without a line is rejected"
  );
  assert.ok(isValid(SCHEMA, payload({ pre_existing_observations: [] })), "an empty array is the no-observations case");
});

// --- Layer 2: the code-tier prompts demand it, and only the code-tier prompts ------

test("both code-tier review prompts state the authorship contract", () => {
  for (const name of ["adversarial-review", "review-mcp"]) {
    const text = fs.readFileSync(path.join(PLUGIN_DIR, "prompts", `${name}.md`), "utf8");
    for (const marker of [
      "`authorship`",
      "`authorship_evidence`",
      "`exposure`",
      "`exposure_evidence`",
      "`pre_existing_observations`",
      "introduced",
      "pre-existing",
      "unverified",
      "change-touches-property",
      "untouched"
    ]) {
      assert.ok(text.includes(marker), `${name}.md must state ${marker}`);
    }
    // The verdict rule is the operative half: classification with no gate changes nothing.
    assert.match(text, /`needs-attention` may rest ONLY on findings/);
    // The Occam carriage note must not be read as forbidding these as schema keys.
    assert.match(text, /ARE\s+schema fields — emit them as normal JSON keys/);
    // The narrow read-only git exception, granted for authorship verification only.
    assert.match(text, /read-only `git show`, `git diff`, and `git log`/);
    assert.match(text, /for authorship verification ONLY/);
  }
});

test("spec and scoping review prompts are untouched by the authorship contract", () => {
  // The directive scoped this to prompts that review a commit or commit range. Spec and
  // scoping reviews judge an artifact, which has no parent commit to diff against.
  for (const name of ["spec-adversarial-review", "scoping-adversarial-review"]) {
    const text = fs.readFileSync(path.join(PLUGIN_DIR, "prompts", `${name}.md`), "utf8");
    assert.ok(!text.includes("authorship"), `${name}.md must not carry the authorship contract`);
    assert.ok(!text.includes("pre_existing_observations"), `${name}.md must not carry the observations array`);
  }
});

// --- Layer 3: the renderer discloses it -------------------------------------------

test("renderer prints authorship and its evidence on every finding", () => {
  const output = render();
  assert.match(output, /Authorship: introduced/);
  assert.match(output, /Authorship evidence: The `\+` hunk at SceneEditor\.jsx:212/);
  // `exposure` only means something for a pre-existing defect; not-applicable is noise.
  assert.doesNotMatch(output, /Exposure:/);
});

test("renderer prints exposure when the defect is pre-existing", () => {
  const output = render({
    findings: [
      finding({
        authorship: "pre-existing",
        authorship_evidence: "Context line SceneEditor.jsx:212 is unchanged in the diff and already lacked the reset.",
        exposure: "change-touches-property",
        exposure_evidence: "The `+` hunk at SceneEditor.jsx:198 routes the save through the confirm path for the first time."
      })
    ]
  });
  assert.match(output, /Authorship: pre-existing/);
  assert.match(output, /Exposure: change-touches-property/);
  assert.match(output, /Exposure evidence: The `\+` hunk at SceneEditor\.jsx:198/);
  // Newly exposed by the change, so it is answerable and the blocking verdict stands.
  assert.doesNotMatch(output, /PLUGIN-AUTHORSHIP-WARNING/);
});

test("a blocking verdict resting on nothing the change is answerable for is flagged", () => {
  const untouched = render({
    findings: [
      finding({
        authorship: "pre-existing",
        authorship_evidence: "Context line SceneEditor.jsx:212 is unchanged in the diff.",
        exposure: "untouched"
      })
    ]
  });
  assert.match(untouched, /PLUGIN-AUTHORSHIP-WARNING/);
  assert.match(untouched, /no finding is `introduced`/);

  const unverified = render({
    findings: [
      finding({
        authorship: "unverified",
        authorship_evidence: "The commit is a shallow-clone boundary, so abc1234^ has no tree to read.",
        exposure: "not-applicable"
      })
    ]
  });
  assert.match(unverified, /PLUGIN-AUTHORSHIP-WARNING/);
});

test("an unclassified finding normalizes to unverified and cannot carry a blocking verdict", () => {
  // Old stored results and any model that drops the field must not read as an accusation.
  const stripped = finding();
  delete stripped.authorship;
  delete stripped.exposure;

  const output = renderReviewResult(
    { parsed: payload({ findings: [stripped] }), rawOutput: "", parseError: null },
    META
  );
  assert.match(output, /Authorship: unverified/);
  assert.match(output, /PLUGIN-AUTHORSHIP-WARNING/);
});

test("an approve verdict is never flagged by the authorship gate", () => {
  const output = render({ verdict: "approve", findings: [] });
  assert.doesNotMatch(output, /PLUGIN-AUTHORSHIP-WARNING/);
});

test("pre-existing observations render as a bare section, outside findings", () => {
  const output = render({
    verdict: "approve",
    findings: [],
    pre_existing_observations: [
      { file: "src/ui/SceneEditor.jsx", line: 212, note: "the confirm dialog already survived a failed save before this change." },
      { file: "src/lib/scenes.js", line: 88, note: "retry backoff was already unbounded." }
    ]
  });

  assert.match(output, /## Pre-existing observations \(not findings\)/);
  assert.match(output, /- src\/ui\/SceneEditor\.jsx:212 — the confirm dialog already survived/);
  assert.match(output, /- src\/lib\/scenes\.js:88 — retry backoff was already unbounded\./);
  // The section is one line per item: no severity, no recommendation, no verdict weight.
  assert.match(output, /No material findings\./);
  assert.match(output, /Verdict: approve/);
});

test("a pre-existing/untouched finding filed as a finding is demoted into the section", () => {
  // Reviewers keep filing these as findings. The placement rule is not self-enforcing, so
  // the renderer moves them rather than trusting it — otherwise a defect the change never
  // touched still reads as a severity-carrying finding against the change.
  const output = render({
    verdict: "needs-attention",
    findings: [
      finding({
        authorship: "pre-existing",
        authorship_evidence: "Context line SceneEditor.jsx:212 is unchanged in the diff and already lacked the reset.",
        exposure: "untouched",
        exposure_evidence: ""
      })
    ]
  });

  assert.match(output, /## Pre-existing observations \(not findings\)/);
  assert.match(output, /- src\/ui\/SceneEditor\.jsx:212 — Confirm dialog is not dismissed on HTTP 503/);
  // It must leave findings entirely: no severity marker, no recommendation, no weight.
  assert.match(output, /No material findings\./);
  assert.doesNotMatch(output, /\[medium\]/);
  assert.doesNotMatch(output, /Recommendation: Clear `confirmOpen`/);
  // And the blocking verdict it was supposed to support is now resting on nothing.
  assert.match(output, /PLUGIN-AUTHORSHIP-WARNING/);
});

test("a demoted item does not suppress genuinely introduced findings", () => {
  const output = render({
    findings: [
      finding(),
      finding({
        title: "Retry backoff is unbounded",
        file: "src/lib/scenes.js",
        line_start: 88,
        line_end: 91,
        authorship: "pre-existing",
        authorship_evidence: "Context line scenes.js:88 is unchanged in the diff.",
        exposure: "untouched",
        exposure_evidence: ""
      })
    ]
  });

  assert.match(output, /\[medium\] Confirm dialog is not dismissed on HTTP 503/);
  assert.match(output, /- src\/lib\/scenes\.js:88 — Retry backoff is unbounded/);
  assert.doesNotMatch(output, /\[medium\] Retry backoff is unbounded/);
  // One `introduced` finding remains, so the blocking verdict is still answerable.
  assert.doesNotMatch(output, /PLUGIN-AUTHORSHIP-WARNING/);
});

test("the observations section is absent when there is nothing to observe", () => {
  assert.doesNotMatch(render(), /Pre-existing observations/);
});
