/**
 * Interpreting validator: executes a canonical `SchemaNode` against input.
 *
 * One function per node kind; composite validators recurse with extended paths
 * so every issue carries its precise location. Validators collect all issues
 * they can (rather than failing fast) except where control flow forbids it.
 */

import type { ValidationIssue } from "./errors.js";
import type {
  ArrayNode,
  BigIntNode,
  DiscriminatedUnionNode,
  IntersectionNode,
  NumberNode,
  ObjectNode,
  RecordNode,
  SchemaNode,
  StringNode,
  TupleNode,
  UnionNode,
} from "./node.js";
import { deepEqual, hasOwn, isPlainObject, preview, receivedKind, setKey } from "./utils.js";

export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: ValidationIssue[] };

function ok(value: unknown): ValidationResult {
  return { ok: true, value };
}

function fail(issues: ValidationIssue[]): ValidationResult {
  return { ok: false, issues };
}

function single(
  code: ValidationIssue["code"],
  path: readonly PropertyKey[],
  message: string,
  expected?: unknown,
  received?: unknown,
): ValidationResult {
  return fail([{ code, path, message, expected, received }]);
}

function child(path: readonly PropertyKey[], key: PropertyKey): readonly PropertyKey[] {
  return [...path, key];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function stringLength(value: string): number {
  return [...value].length;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isMultipleOf(value: number, divisor: number): boolean {
  if (divisor === 0 || !Number.isFinite(divisor)) {
    return false;
  }
  const quotient = value / divisor;
  const nearest = Math.round(quotient);
  return Math.abs(quotient - nearest) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8;
}

function validateString(
  node: StringNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (typeof input !== "string") {
    return single(
      "invalid_type",
      path,
      `Expected string, received ${receivedKind(input)}`,
      "string",
      input,
    );
  }
  let value = input;
  let cachedLen: number | undefined;
  const getLen = (v: string): number => {
    if (cachedLen !== undefined) return cachedLen;
    cachedLen = stringLength(v);
    return cachedLen;
  };
  const invalidateLen = () => {
    cachedLen = undefined;
  };
  const issues: ValidationIssue[] = [];
  for (const check of node.checks) {
    switch (check.kind) {
      case "trim": {
        const next = value.trim();
        if (next !== value) invalidateLen();
        value = next;
        break;
      }
      case "toLowerCase": {
        const next = value.toLowerCase();
        if (next !== value) invalidateLen();
        value = next;
        break;
      }
      case "toUpperCase": {
        const next = value.toUpperCase();
        if (next !== value) invalidateLen();
        value = next;
        break;
      }
      case "min":
        if (getLen(value) < check.value) {
          issues.push({
            code: "too_small",
            path,
            message: check.message ?? `Too small: expected string with length >= ${check.value}`,
            expected: check.value,
            received: value,
          });
        }
        break;
      case "max":
        if (getLen(value) > check.value) {
          issues.push({
            code: "too_big",
            path,
            message: check.message ?? `Too big: expected string with length <= ${check.value}`,
            expected: check.value,
            received: value,
          });
        }
        break;
      case "length": {
        const len = getLen(value);
        if (len !== check.value) {
          issues.push({
            code: check.value > len ? "too_small" : "too_big",
            path,
            message: check.message ?? `Invalid length: expected string with length ${check.value}`,
            expected: check.value,
            received: value,
          });
        }
        break;
      }
      case "email":
        if (!EMAIL_PATTERN.test(value)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid email address",
            expected: "email",
            received: value,
          });
        }
        break;
      case "url":
        if (!isValidUrl(value)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid URL",
            expected: "url",
            received: value,
          });
        }
        break;
      case "uuid":
        if (!UUID_PATTERN.test(value)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid UUID",
            expected: "uuid",
            received: value,
          });
        }
        break;
      case "datetime":
        if (!DATETIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid datetime string",
            expected: "datetime",
            received: value,
          });
        }
        break;
      case "regex":
        if (!check.pattern.test(value)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? `Invalid format: expected string matching ${check.pattern}`,
            expected: String(check.pattern),
            received: value,
          });
        }
        break;
      case "startsWith":
        if (!value.startsWith(check.value)) {
          issues.push({
            code: "invalid_format",
            path,
            message:
              check.message ?? `Invalid string: expected to start with ${preview(check.value)}`,
            expected: check.value,
            received: value,
          });
        }
        break;
      case "endsWith":
        if (!value.endsWith(check.value)) {
          issues.push({
            code: "invalid_format",
            path,
            message:
              check.message ?? `Invalid string: expected to end with ${preview(check.value)}`,
            expected: check.value,
            received: value,
          });
        }
        break;
      case "includes":
        if (!value.includes(check.value)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? `Invalid string: expected to include ${preview(check.value)}`,
            expected: check.value,
            received: value,
          });
        }
        break;
    }
  }
  return issues.length > 0 ? fail(issues) : ok(value);
}

function boundMessage(label: string, operator: string, bound: unknown, input: unknown): string {
  return `Too ${operator === ">=" || operator === ">" ? "small" : "big"}: expected ${label} ${operator} ${String(bound)}, received ${preview(input)}`;
}

function validateNumber(
  node: NumberNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return single(
      "invalid_type",
      path,
      `Expected number, received ${receivedKind(input)}`,
      "number",
      input,
    );
  }
  const issues: ValidationIssue[] = [];
  for (const check of node.checks) {
    switch (check.kind) {
      case "min":
      case "gte":
        if (input < check.value) {
          issues.push({
            code: "too_small",
            path,
            message: check.message ?? boundMessage("number", ">=", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "max":
      case "lte":
        if (input > check.value) {
          issues.push({
            code: "too_big",
            path,
            message: check.message ?? boundMessage("number", "<=", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "gt":
        if (input <= check.value) {
          issues.push({
            code: "too_small",
            path,
            message: check.message ?? boundMessage("number", ">", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "lt":
        if (input >= check.value) {
          issues.push({
            code: "too_big",
            path,
            message: check.message ?? boundMessage("number", "<", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "multipleOf":
        if (!isMultipleOf(input, check.value)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? `Invalid number: expected a multiple of ${check.value}`,
            expected: check.value,
            received: input,
          });
        }
        break;
      case "int":
        if (!Number.isInteger(input)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid number: expected an integer",
            expected: "integer",
            received: input,
          });
        }
        break;
      case "finite":
        if (!Number.isFinite(input)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid number: expected a finite number",
            expected: "finite",
            received: input,
          });
        }
        break;
      case "safe":
        if (!Number.isSafeInteger(input)) {
          issues.push({
            code: "invalid_format",
            path,
            message: check.message ?? "Invalid number: expected a safe integer",
            expected: "safe integer",
            received: input,
          });
        }
        break;
    }
  }
  return issues.length > 0 ? fail(issues) : ok(input);
}

function validateBigInt(
  node: BigIntNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (typeof input !== "bigint") {
    return single(
      "invalid_type",
      path,
      `Expected bigint, received ${receivedKind(input)}`,
      "bigint",
      input,
    );
  }
  const issues: ValidationIssue[] = [];
  for (const check of node.checks) {
    switch (check.kind) {
      case "min":
      case "gte":
        if (input < check.value) {
          issues.push({
            code: "too_small",
            path,
            message: check.message ?? boundMessage("bigint", ">=", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "max":
      case "lte":
        if (input > check.value) {
          issues.push({
            code: "too_big",
            path,
            message: check.message ?? boundMessage("bigint", "<=", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "gt":
        if (input <= check.value) {
          issues.push({
            code: "too_small",
            path,
            message: check.message ?? boundMessage("bigint", ">", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "lt":
        if (input >= check.value) {
          issues.push({
            code: "too_big",
            path,
            message: check.message ?? boundMessage("bigint", "<", check.value, input),
            expected: check.value,
            received: input,
          });
        }
        break;
      case "multipleOf":
        if (check.value === 0n || input % check.value !== 0n) {
          issues.push({
            code: "invalid_format",
            path,
            message:
              check.message ?? `Invalid bigint: expected a multiple of ${String(check.value)}`,
            expected: check.value,
            received: input,
          });
        }
        break;
    }
  }
  return issues.length > 0 ? fail(issues) : ok(input);
}

function copyDefault(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  // Use structuredClone for deep copy when available (Node 22), otherwise shallow+deep for known cases
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // fall through to shallow copy
    }
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  if (isPlainObject(value)) {
    return { ...value };
  }
  return value;
}

function validateObject(
  node: ObjectNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (!isPlainObject(input)) {
    return single(
      "invalid_type",
      path,
      `Expected object, received ${receivedKind(input)}`,
      "object",
      input,
    );
  }
  const issues: ValidationIssue[] = [];
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(node.fields)) {
    const fieldPath = child(path, key);
    if (hasOwn(input, key)) {
      const result = validateNode(field, input[key], fieldPath);
      if (!result.ok) {
        issues.push(...result.issues);
      } else {
        setKey(output, key, result.value);
      }
    } else if (field.kind === "optional") {
      continue;
    } else if (field.kind === "default") {
      setKey(output, key, copyDefault(field.value));
    } else {
      const result = validateNode(field, undefined, fieldPath);
      if (!result.ok) {
        issues.push(...result.issues);
      } else {
        setKey(output, key, result.value);
      }
    }
  }
  for (const key of Object.keys(input)) {
    if (hasOwn(node.fields, key)) {
      continue;
    }
    if (node.unknownKeys === "strict") {
      issues.push({
        code: "unrecognized_keys",
        path: child(path, key),
        message: `Unrecognized key: ${preview(key)}`,
        received: key,
      });
    } else if (node.unknownKeys === "passthrough") {
      setKey(output, key, input[key]);
    }
  }
  return issues.length > 0 ? fail(issues) : ok(output);
}

function validateArray(
  node: ArrayNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (!Array.isArray(input)) {
    return single(
      "invalid_type",
      path,
      `Expected array, received ${receivedKind(input)}`,
      "array",
      input,
    );
  }
  const issues: ValidationIssue[] = [];
  for (const check of node.checks) {
    if (check.kind === "min" && input.length < check.value) {
      issues.push({
        code: "too_small",
        path,
        message: check.message ?? `Too small: expected array with length >= ${check.value}`,
        expected: check.value,
        received: input.length,
      });
    } else if (check.kind === "max" && input.length > check.value) {
      issues.push({
        code: "too_big",
        path,
        message: check.message ?? `Too big: expected array with length <= ${check.value}`,
        expected: check.value,
        received: input.length,
      });
    } else if (check.kind === "length" && input.length !== check.value) {
      issues.push({
        code: input.length < check.value ? "too_small" : "too_big",
        path,
        message: check.message ?? `Invalid length: expected array with length ${check.value}`,
        expected: check.value,
        received: input.length,
      });
    }
  }
  const output: unknown[] = [];
  input.forEach((item, index) => {
    const result = validateNode(node.element, item, child(path, index));
    if (!result.ok) {
      issues.push(...result.issues);
    } else {
      output[index] = result.value;
    }
  });
  return issues.length > 0 ? fail(issues) : ok(output);
}

function validateTuple(
  node: TupleNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (!Array.isArray(input)) {
    return single(
      "invalid_type",
      path,
      `Expected tuple, received ${receivedKind(input)}`,
      "tuple",
      input,
    );
  }
  const issues: ValidationIssue[] = [];
  if (input.length !== node.items.length) {
    issues.push({
      code: input.length < node.items.length ? "too_small" : "too_big",
      path,
      message: `Invalid length: expected tuple with length ${node.items.length}`,
      expected: node.items.length,
      received: input.length,
    });
  }
  const output: unknown[] = [];
  const count = Math.min(input.length, node.items.length);
  for (const [index, item] of node.items.slice(0, count).entries()) {
    const result = validateNode(item, input[index], child(path, index));
    if (!result.ok) {
      issues.push(...result.issues);
    } else {
      output[index] = result.value;
    }
  }
  return issues.length > 0 ? fail(issues) : ok(output);
}

function validateRecord(
  node: RecordNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (!isPlainObject(input)) {
    return single(
      "invalid_type",
      path,
      `Expected record, received ${receivedKind(input)}`,
      "record",
      input,
    );
  }
  const issues: ValidationIssue[] = [];
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const keyPath = child(path, key);
    if (node.keys.kind === "number") {
      if (key.trim() === "" || Number.isNaN(Number(key))) {
        issues.push({
          code: "invalid_type",
          path: keyPath,
          message: `Expected numeric key, received ${preview(key)}`,
          expected: "number",
          received: key,
        });
        continue;
      }
      const keyResult = validateNode(node.keys, Number(key), keyPath);
      if (!keyResult.ok) {
        issues.push(...keyResult.issues);
        continue;
      }
    } else {
      const keyResult = validateNode(node.keys, key, keyPath);
      if (!keyResult.ok) {
        issues.push(...keyResult.issues);
        continue;
      }
    }
    const valueResult = validateNode(node.values, input[key], keyPath);
    if (!valueResult.ok) {
      issues.push(...valueResult.issues);
    } else {
      setKey(output, key, valueResult.value);
    }
  }
  return issues.length > 0 ? fail(issues) : ok(output);
}

function describeVariant(node: SchemaNode): string {
  switch (node.kind) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "date":
    case "object":
    case "array":
    case "tuple":
    case "record":
    case "union":
    case "intersection":
    case "null":
    case "undefined":
    case "any":
    case "unknown":
    case "never":
      return node.kind;
    case "literal":
      return preview(node.value);
    case "enum":
      return node.values.map((value) => preview(value)).join(" | ");
    case "optional":
      return `${describeVariant(node.inner)} | undefined`;
    case "nullable":
      return `${describeVariant(node.inner)} | null`;
    case "default":
      return describeVariant(node.inner);
    case "transform":
    case "refine":
    case "lazy":
      return node.kind;
    case "discriminatedUnion":
      return "discriminatedUnion";
  }
}

function validateUnion(
  node: UnionNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  const collected: ValidationIssue[] = [];
  for (const variant of node.variants) {
    const result = validateNode(variant, input, path);
    if (result.ok) {
      return result;
    }
    collected.push(...result.issues);
  }
  const expected = node.variants.map(describeVariant).join(" | ");
  return fail([
    {
      code: "invalid_union",
      path,
      message: `Invalid union: expected ${expected}, received ${receivedKind(input)}`,
      expected,
      received: input,
    },
    ...collected,
  ]);
}

function validateDiscriminatedUnion(
  node: DiscriminatedUnionNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  if (!isPlainObject(input)) {
    return single(
      "invalid_type",
      path,
      `Expected object, received ${receivedKind(input)}`,
      "object",
      input,
    );
  }
  const discriminator = hasOwn(input, node.discriminator) ? input[node.discriminator] : undefined;
  if (typeof discriminator !== "string") {
    return single(
      "invalid_union",
      child(path, node.discriminator),
      `Invalid discriminator: expected ${preview(node.discriminator)} to be a string`,
      node.variants.map((variant) => variant.key),
      discriminator,
    );
  }
  const variant = node.variants.find((candidate) => candidate.key === discriminator);
  if (variant === undefined) {
    return single(
      "invalid_union",
      child(path, node.discriminator),
      `Invalid discriminator: expected one of ${node.variants.map((candidate) => preview(candidate.key)).join(", ")}`,
      node.variants.map((candidate) => candidate.key),
      discriminator,
    );
  }
  return validateNode(variant.node, input, path);
}

function validateIntersection(
  node: IntersectionNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  const left = validateNode(node.left, input, path);
  const right = validateNode(node.right, input, path);
  const issues: ValidationIssue[] = [
    ...(left.ok ? [] : left.issues),
    ...(right.ok ? [] : right.issues),
  ];
  if (!left.ok || !right.ok) {
    return fail(issues);
  }
  if (isPlainObject(left.value) && isPlainObject(right.value)) {
    const merged: Record<string, unknown> = { ...left.value };
    for (const key of Object.keys(right.value)) {
      if (hasOwn(merged, key) && !deepEqual(merged[key], right.value[key])) {
        issues.push({
          code: "invalid_intersection",
          path: child(path, key),
          message: `Conflicting values for intersection at ${preview(key)}`,
          received: right.value[key],
        });
      } else {
        setKey(merged, key, right.value[key]);
      }
    }
    return issues.length > 0 ? fail(issues) : ok(merged);
  }
  if (deepEqual(left.value, right.value)) {
    return ok(left.value);
  }
  return single(
    "invalid_intersection",
    path,
    "Conflicting values for intersection",
    undefined,
    input,
  );
}

export function validateNode(
  node: SchemaNode,
  input: unknown,
  path: readonly PropertyKey[],
): ValidationResult {
  switch (node.kind) {
    case "string":
      return validateString(node, input, path);
    case "number":
      return validateNumber(node, input, path);
    case "boolean":
      return typeof input === "boolean"
        ? ok(input)
        : single(
            "invalid_type",
            path,
            `Expected boolean, received ${receivedKind(input)}`,
            "boolean",
            input,
          );
    case "bigint":
      return validateBigInt(node, input, path);
    case "date":
      return input instanceof Date && !Number.isNaN(input.getTime())
        ? ok(new Date(input.getTime()))
        : single(
            "invalid_type",
            path,
            `Expected Date, received ${receivedKind(input)}`,
            "Date",
            input,
          );
    case "literal":
      return Object.is(input, node.value)
        ? ok(input)
        : single(
            "invalid_literal",
            path,
            `Expected ${preview(node.value)}, received ${preview(input)}`,
            node.value,
            input,
          );
    case "enum":
      return typeof input === "string" && node.values.includes(input)
        ? ok(input)
        : single(
            "invalid_enum",
            path,
            `Expected one of ${node.values.map((value) => preview(value)).join(", ")}, received ${preview(input)}`,
            [...node.values],
            input,
          );
    case "null":
      return input === null
        ? ok(input)
        : single(
            "invalid_type",
            path,
            `Expected null, received ${receivedKind(input)}`,
            "null",
            input,
          );
    case "undefined":
      return input === undefined
        ? ok(input)
        : single(
            "invalid_type",
            path,
            `Expected undefined, received ${receivedKind(input)}`,
            "undefined",
            input,
          );
    case "any":
    case "unknown":
      return ok(input);
    case "never":
      return single(
        "invalid_type",
        path,
        `Expected never, received ${receivedKind(input)}`,
        "never",
        input,
      );
    case "object":
      return validateObject(node, input, path);
    case "array":
      return validateArray(node, input, path);
    case "tuple":
      return validateTuple(node, input, path);
    case "record":
      return validateRecord(node, input, path);
    case "union":
      return validateUnion(node, input, path);
    case "discriminatedUnion":
      return validateDiscriminatedUnion(node, input, path);
    case "intersection":
      return validateIntersection(node, input, path);
    case "optional":
      return input === undefined ? ok(input) : validateNode(node.inner, input, path);
    case "nullable":
      return input === null ? ok(input) : validateNode(node.inner, input, path);
    case "default":
      return input === undefined
        ? ok(copyDefault(node.value))
        : validateNode(node.inner, input, path);
    case "transform": {
      const inner = validateNode(node.inner, input, path);
      if (!inner.ok) {
        return inner;
      }
      try {
        return ok(node.transform(inner.value));
      } catch (e) {
        return fail([
          {
            code: "custom",
            path,
            message: (e as Error)?.message ?? "Transform failed",
            received: inner.value,
          },
        ]);
      }
    }
    case "refine": {
      const inner = validateNode(node.inner, input, path);
      if (!inner.ok) {
        return inner;
      }
      const issues: ValidationIssue[] = [];
      for (const refinement of node.refinements) {
        try {
          if (!refinement.predicate(inner.value)) {
            issues.push({
              code: "custom",
              path,
              message: refinement.message ?? "Invalid value",
              received: inner.value,
            });
          }
        } catch (e) {
          issues.push({
            code: "custom",
            path,
            message: (e as Error)?.message ?? refinement.message ?? "Invalid value",
            received: inner.value,
          });
        }
      }
      return issues.length > 0 ? fail(issues) : ok(inner.value);
    }
    case "lazy":
      return validateNode(node.resolve(), input, path);
  }
}
