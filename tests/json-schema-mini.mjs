// Minimal JSON Schema validator covering exactly the keyword subset used by
// plugins/codex/schemas/review-output.schema.json. The repo ships no runtime deps,
// and the review schema is enforced upstream by the model provider, so this exists
// only so fixtures can assert accept/reject the same way the provider would.
//
// Supported: type, enum, required, properties, additionalProperties, items,
// minItems, uniqueItems, minLength, minimum, maximum.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") {
    return actual === "number" || actual === "integer";
  }
  if (expected === "integer") {
    return actual === "integer";
  }
  return actual === expected;
}

export function validate(schema, value, path = "$") {
  const errors = [];

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected type ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: array shorter than minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) {
        errors.push(`${path}: array items are not unique`);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validate(schema.items, item, `${path}[${index}]`));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}: missing required property \`${key}\``);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      if (properties[key]) {
        errors.push(...validate(properties[key], entry, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property \`${key}\``);
      }
    }
  }

  return errors;
}

export function isValid(schema, value) {
  return validate(schema, value).length === 0;
}
