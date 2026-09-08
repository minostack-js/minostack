/**
 * MinoStack schema → GraphQL SDL converter.
 *
 * Emits `type` (output side) + `input` (input side) for every object, shared
 * enums/unions/scalars, with deterministic derived names. GraphQL cannot
 * express everything (tuples, records, intersections, transform outputs,
 * refinements); those convert to their closest shape PLUS a machine-readable
 * warning — nothing is silently lost. See the package README for the full
 * mapping table.
 *
 * Enterprise extensions:
 * - Operation roots: `Query`/`Mutation`/`Subscription` are rendered as `type`
 *   only (no `input`), with optional `schema { query: Query ... }` block and
 *   field args via `facet("field", { args: { id: m.string() } })`.
 * - Federation (Apollo v2): per-type/field directives via
 *   `facet("federation", { key: "id", shareable: true, external: true, ... })`
 *   and top-level `sdl(types, { federation: { enabled: true } })` which emits
 *   `extend schema @link(...)`.
 *
 * Entry: `sdl({ Name: schema })` — top-level map keys name the roots.
 * Enterprise: `sdl({ User }, { query: { me: User }, federation: { enabled: true } })`.
 */

import type { IntersectionNode, ObjectNode, Schema, SchemaNode } from "@minostack/schema";
import type {
  Context,
  FederationFacet,
  FieldFacet,
  GraphqlWarning,
  SdlOptions,
  SdlResult,
} from "./types.js";

const NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
const OPERATION_ROOT_NAMES = new Set(["Query", "Mutation", "Subscription"]);

function warn(ctx: Context, path: readonly PropertyKey[], code: string, message: string): void {
  ctx.warnings.push({ path: [...path], code, message });
}

function sanitizeName(raw: string, fallback: string): string {
  let out = raw.replace(/[^_0-9A-Za-z]/g, "_");
  if (out === "" || /^[0-9]/.test(out)) {
    out = `_${out}`;
  }
  if (out === "_") {
    return fallback;
  }
  return out;
}

function claimName(
  ctx: Context,
  path: readonly PropertyKey[],
  base: string,
  fallback: string,
): string {
  const clean = sanitizeName(base, fallback);
  let candidate = clean;
  let index = 2;
  while (ctx.names.has(candidate)) {
    candidate = `${clean}${index}`;
    index += 1;
  }
  ctx.names.add(candidate);
  if (candidate !== base) {
    warn(
      ctx,
      path,
      "name-sanitized",
      `Name ${JSON.stringify(base)} emitted as ${JSON.stringify(candidate)}.`,
    );
  }
  return candidate;
}

function pascalCase(raw: string): string {
  const parts = raw.split(/[^0-9A-Za-z]+/).filter((part) => part !== "");
  if (parts.length === 0) {
    return "";
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(description: string | undefined): string[] {
  if (description === undefined) {
    return [];
  }
  const safe = description.replace(/\\/g, "\\\\").replace(/"""/g, '\\"""');
  return [`"""${safe}"""`];
}

function deprecation(deprecated: boolean | string | undefined): string {
  if (deprecated === true) {
    return " @deprecated";
  }
  if (typeof deprecated === "string") {
    return ` @deprecated(reason: ${JSON.stringify(deprecated)})`;
  }
  return "";
}

function isOperationRootName(name: string): boolean {
  return OPERATION_ROOT_NAMES.has(name);
}

function readFederationFacet(node: SchemaNode): FederationFacet | undefined {
  const facets = node.facets as Record<string, unknown>;
  const raw =
    facets["federation"] ??
    facets["graphql.federation"] ??
    facets["apollo.federation"] ??
    facets["federation:"] ??
    undefined;
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return { key: raw };
  if (typeof raw === "object" && raw !== null) return raw as FederationFacet;
  return undefined;
}

function readFieldFacet(node: SchemaNode): FieldFacet | undefined {
  const facets = node.facets as Record<string, unknown>;
  const raw = facets["field"] ?? facets["graphql.field"] ?? facets["args"] ?? undefined;
  if (raw !== undefined && typeof raw === "object" && raw !== null) return raw as FieldFacet;
  return undefined;
}

function federationTypeDirectives(node: SchemaNode, ctx: Context): string {
  if (!ctx.federationEnabled) return "";
  const facet = readFederationFacet(node);
  if (facet === undefined) return "";
  const parts: string[] = [];
  if (facet.key !== undefined) parts.push(`@key(fields: ${JSON.stringify(facet.key)})`);
  if (facet.keys !== undefined) {
    for (const k of facet.keys) parts.push(`@key(fields: ${JSON.stringify(k)})`);
  }
  if (facet.shareable) parts.push("@shareable");
  if (facet.inaccessible) parts.push("@inaccessible");
  if (facet.tags !== undefined) {
    for (const t of facet.tags) parts.push(`@tag(name: ${JSON.stringify(t)})`);
  }
  if (facet.override !== undefined)
    parts.push(`@override(from: ${JSON.stringify(facet.override)})`);
  if (facet.directives !== undefined) parts.push(...facet.directives);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function federationFieldDirectives(node: SchemaNode, ctx: Context): string {
  if (!ctx.federationEnabled) return "";
  const facet = readFederationFacet(node);
  if (facet === undefined) return "";
  const parts: string[] = [];
  if (facet.shareable) parts.push("@shareable");
  if (facet.external) parts.push("@external");
  if (facet.provides !== undefined)
    parts.push(`@provides(fields: ${JSON.stringify(facet.provides)})`);
  if (facet.requires !== undefined)
    parts.push(`@requires(fields: ${JSON.stringify(facet.requires)})`);
  if (facet.override !== undefined)
    parts.push(`@override(from: ${JSON.stringify(facet.override)})`);
  if (facet.tags !== undefined) {
    for (const t of facet.tags) parts.push(`@tag(name: ${JSON.stringify(t)})`);
  }
  if (facet.inaccessible) parts.push("@inaccessible");
  if (facet.directives !== undefined) parts.push(...facet.directives);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function isFederationExtends(node: SchemaNode, ctx: Context): boolean {
  if (!ctx.federationEnabled) return false;
  const facet = readFederationFacet(node);
  return facet?.extends === true;
}

/** Static "accepts undefined on input" analysis. Exact for all valid schemas. */
function inputUndef(node: SchemaNode, seen: Set<SchemaNode>): boolean {
  switch (node.kind) {
    case "optional":
    case "default":
    case "any":
    case "unknown":
    case "undefined":
      return true;
    case "literal":
      return node.value === undefined;
    case "null":
    case "never":
      return false;
    case "nullable":
    case "refine":
    case "transform":
      return inputUndef(node.inner, seen);
    case "union":
      return node.variants.some((variant) => inputUndef(variant, seen));
    case "lazy": {
      if (seen.has(node)) {
        return false;
      }
      seen.add(node);
      try {
        return inputUndef(node.resolve(), seen);
      } finally {
        seen.delete(node);
      }
    }
    default:
      return false;
  }
}

/** Static "output may be undefined" analysis. Conservative on transforms. */
function outputUndef(node: SchemaNode, seen: Set<SchemaNode>): boolean {
  switch (node.kind) {
    case "optional":
    case "any":
    case "unknown":
    case "undefined":
      return true;
    case "literal":
      return node.value === undefined;
    case "null":
    case "never":
      return false;
    case "default":
    case "nullable":
    case "refine":
      return outputUndef(node.inner, seen);
    case "transform":
      return true;
    case "union":
      return node.variants.some((variant) => outputUndef(variant, seen));
    case "lazy": {
      if (seen.has(node)) {
        return true;
      }
      seen.add(node);
      try {
        return outputUndef(node.resolve(), seen);
      } finally {
        seen.delete(node);
      }
    }
    default:
      return false;
  }
}

/** Static "output may be null" analysis. */
function nullAccepting(node: SchemaNode, seen: Set<SchemaNode>): boolean {
  switch (node.kind) {
    case "nullable":
    case "null":
      return true;
    case "literal":
      return node.value === null;
    case "never":
      return false;
    case "optional":
    case "default":
    case "refine":
    case "transform":
      return nullAccepting(node.inner, seen);
    case "union":
      return node.variants.some((variant) => nullAccepting(variant, seen));
    case "lazy": {
      if (seen.has(node)) {
        return false;
      }
      seen.add(node);
      try {
        return nullAccepting(node.resolve(), seen);
      } finally {
        seen.delete(node);
      }
    }
    default:
      return false;
  }
}

/** Non-null (`!`) iff required AND neither undefined nor null can occur. */
function nonNull(node: SchemaNode, side: "input" | "output"): boolean {
  const undef = side === "input" ? inputUndef(node, new Set()) : outputUndef(node, new Set());
  return !undef && !nullAccepting(node, new Set());
}

function defaultLiteral(
  value: unknown,
  field: SchemaNode,
): { ok: true; text: string } | { ok: false } {
  let inner = field;
  while (inner.kind === "default" || inner.kind === "nullable" || inner.kind === "optional") {
    inner = inner.inner;
  }
  if (typeof value === "string") {
    if (inner.kind === "enum" && inner.values.includes(value)) {
      return { ok: true, text: sanitizeName(value, "V") };
    }
    if (inner.kind === "literal" && inner.value === value) {
      return { ok: true, text: sanitizeName(value, "V") };
    }
    return { ok: true, text: JSON.stringify(value) };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, text: String(value) };
  }
  if (typeof value === "boolean") {
    return { ok: true, text: value ? "true" : "false" };
  }
  if (value === null) {
    return { ok: true, text: "null" };
  }
  if (typeof value === "bigint") {
    return { ok: true, text: String(value) };
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { ok: true, text: JSON.stringify(value.toISOString()) };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const literal = defaultLiteral(item, field);
      if (!literal.ok) {
        return { ok: false };
      }
      parts.push(literal.text);
    }
    return { ok: true, text: `[${parts.join(", ")}]` };
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
      if (!NAME_RE.test(key)) {
        return { ok: false };
      }
      const literal = defaultLiteral(value[key], field);
      if (!literal.ok) {
        return { ok: false };
      }
      parts.push(`${key}: ${literal.text}`);
    }
    return { ok: true, text: `{${parts.join(", ")}}` };
  }
  return { ok: false };
}

function emitEnumBlock(
  ctx: Context,
  path: readonly PropertyKey[],
  name: string,
  values: readonly string[],
  description: string | undefined,
): void {
  const seen = new Set<string>();
  const members: string[] = [];
  for (const value of values) {
    const member = sanitizeName(value, "V");
    if (member !== value) {
      warn(
        ctx,
        path,
        "name-sanitized",
        `Enum value ${JSON.stringify(value)} emitted as ${JSON.stringify(member)}.`,
      );
    }
    let candidate = member;
    let index = 2;
    while (seen.has(candidate)) {
      candidate = `${member}${index}`;
      index += 1;
    }
    if (candidate !== member) {
      warn(
        ctx,
        path,
        "name-sanitized",
        `Enum value ${JSON.stringify(value)} deduplicated as ${JSON.stringify(candidate)}.`,
      );
    }
    seen.add(candidate);
    members.push(`  ${candidate}`);
  }
  ctx.enumBlocks.push([...describe(description), `enum ${name} {`, ...members, "}"].join("\n"));
}

function enumTypeName(
  node: { values: readonly string[]; metadata: { description?: string; id?: string } },
  identity: SchemaNode,
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
  prename?: string,
): string {
  const existing = ctx.declared.get(identity);
  if (existing !== undefined && existing.kind === "enum") {
    return existing.name;
  }
  const id = node.metadata.id;
  const effective = typeof id === "string" && id !== "" ? id : hint;
  const name = prename ?? claimName(ctx, path, effective, "AnonymousEnum");
  ctx.declared.set(identity, { kind: "enum", name });
  emitEnumBlock(ctx, path, name, node.values, node.metadata.description);
  return name;
}

function fieldArgsString(
  fieldNode: SchemaNode,
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
): string {
  const facet = readFieldFacet(fieldNode);
  if (facet?.args === undefined) return "";
  const args = facet.args;
  if (typeof args !== "object" || args === null) return "";
  const entries = Object.entries(args as Record<string, Schema<unknown, unknown>>);
  if (entries.length === 0) return "";
  const parts: string[] = [];
  for (const [argName, argSchema] of entries) {
    const sanitizedArg = sanitizeName(argName, "arg");
    if (sanitizedArg !== argName) {
      warn(
        ctx,
        [...path, argName],
        "name-sanitized",
        `Arg ${JSON.stringify(argName)} emitted as ${JSON.stringify(sanitizedArg)}.`,
      );
    }
    const argPath = [...path, argName];
    const typeStr = ref(argSchema.node, ctx, argPath, `${hint}${pascalCase(argName)}`, "input");
    const nn = nonNull(argSchema.node, "input");
    let part = `${sanitizedArg}: ${typeStr}${nn ? "!" : ""}`;
    if (argSchema.node.kind === "default") {
      const lit = defaultLiteral((argSchema.node as { value: unknown }).value, argSchema.node);
      if (lit.ok) part += ` = ${lit.text}`;
      else
        warn(
          ctx,
          argPath,
          "nonserializable-default",
          "Default value is not SDL-serializable and was omitted.",
        );
    }
    parts.push(part);
  }
  return `(${parts.join(", ")})`;
}

function ref(
  node: SchemaNode,
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
  side: "input" | "output",
): string {
  switch (node.kind) {
    case "string": {
      const normalizers = node.checks
        .map((check) => check.kind)
        .filter((kind) => kind === "trim" || kind === "toLowerCase" || kind === "toUpperCase");
      if (normalizers.length > 0) {
        warn(
          ctx,
          path,
          "normalizer-dropped",
          `String normalizer${normalizers.length === 1 ? "" : "s"} (${normalizers.join(", ")}) change values and have no GraphQL representation.`,
        );
      }
      return "String";
    }
    case "number":
      return node.checks.some((check) => check.kind === "int" || check.kind === "safe")
        ? "Int"
        : "Float";
    case "boolean":
      return "Boolean";
    case "bigint":
      ctx.scalars.add("BigInt");
      return "BigInt";
    case "date":
      ctx.scalars.add("DateTime");
      return "DateTime";
    case "literal": {
      const value = node.value;
      if (typeof value === "string") {
        return enumTypeName({ values: [value], metadata: node.metadata }, node, ctx, path, hint);
      }
      if (typeof value === "bigint") {
        ctx.scalars.add("BigInt");
        return "BigInt";
      }
      warn(
        ctx,
        path,
        "literal-fallback",
        `Literal ${String(value)} has no GraphQL representation; emitted by base scalar.`,
      );
      if (typeof value === "number") {
        return Number.isInteger(value) ? "Int" : "Float";
      }
      if (typeof value === "boolean") {
        return "Boolean";
      }
      return "String";
    }
    case "enum":
      return enumTypeName(node, node, ctx, path, hint);
    case "null":
    case "undefined":
      warn(
        ctx,
        path,
        "literal-fallback",
        `Literal ${node.kind} has no GraphQL representation; emitted as String.`,
      );
      return "String";
    case "any":
    case "unknown":
      ctx.scalars.add("JSON");
      return "JSON";
    case "never":
      warn(ctx, path, "never-as-json", "m.never() has no GraphQL representation; emitted as JSON.");
      ctx.scalars.add("JSON");
      return "JSON";
    case "object": {
      const declared = objectName(node, ctx, path, hint);
      return side === "input" ? declared.inputName : declared.typeName;
    }
    case "array": {
      const item = ref(node.element, ctx, path, hint, side);
      const required = nonNull(node.element, side);
      return `[${item}${required ? "!" : ""}]`;
    }
    case "tuple":
      return tupleRef(node.items, ctx, path, hint, side);
    case "record":
      warn(
        ctx,
        path,
        "record-as-json",
        "Records (key-value maps) have no GraphQL representation; emitted as JSON.",
      );
      ctx.scalars.add("JSON");
      return "JSON";
    case "union":
      return unionTypeName(node, node.variants, ctx, path, hint, side, false);
    case "discriminatedUnion":
      return unionTypeName(
        node,
        node.variants.map((variant) => variant.node),
        ctx,
        path,
        hint,
        side,
        true,
      );
    case "intersection":
      return intersectionRef(node, ctx, path, hint, side);
    case "optional":
    case "nullable":
      return ref(node.inner, ctx, path, hint, side);
    case "default":
      return ref(node.inner, ctx, path, hint, side);
    case "transform":
      if (side === "input") {
        return ref(node.inner, ctx, path, hint, side);
      }
      warn(
        ctx,
        path,
        "transform-output-opaque",
        "Transform output type is not statically known; emitted as JSON.",
      );
      ctx.scalars.add("JSON");
      return "JSON";
    case "refine":
      warn(
        ctx,
        path,
        "refinement-dropped",
        `Refinement (${node.refinements.length} predicate${node.refinements.length === 1 ? "" : "s"}) is not enforceable in GraphQL.`,
      );
      return ref(node.inner, ctx, path, hint, side);
    case "lazy": {
      if (ctx.active.includes(node)) {
        throw new Error("Unresolvable lazy cycle: recursive schemas need a named object boundary.");
      }
      ctx.active.push(node);
      try {
        return ref(node.resolve(), ctx, path, hint, side);
      } finally {
        ctx.active.pop();
      }
    }
  }
}

function tupleRef(
  items: readonly SchemaNode[],
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
  side: "input" | "output",
): string {
  const refs = items.map((item, index) => {
    const itemRef = ref(item, ctx, [...path, index], hint, side);
    return `${itemRef}${nonNull(item, side) ? "!" : ""}`;
  });
  const first = refs[0];
  if (first !== undefined && refs.every((item) => item === first)) {
    warn(
      ctx,
      path,
      "tuple-length-lost",
      "Tuples have no GraphQL representation; emitted as a homogeneous list (length not enforced).",
    );
    return `[${first}]`;
  }
  warn(
    ctx,
    path,
    "tuple-as-json",
    "Heterogeneous tuples have no GraphQL representation; emitted as JSON.",
  );
  ctx.scalars.add("JSON");
  return "JSON";
}

function unionTypeName(
  identity: SchemaNode,
  variants: readonly SchemaNode[],
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
  side: "input" | "output",
  fromDiscriminated: boolean,
  prename?: string,
): string {
  if (side === "input") {
    warn(
      ctx,
      path,
      "input-union-as-json",
      "GraphQL unions are output-only; input unions emitted as JSON.",
    );
    ctx.scalars.add("JSON");
    return "JSON";
  }
  const existing = ctx.declared.get(identity);
  if (existing !== undefined && existing.kind === "union") {
    return existing.name;
  }
  const objects: SchemaNode[] = [];
  for (const variant of variants) {
    if (
      variant.kind === "null" ||
      variant.kind === "undefined" ||
      (variant.kind === "literal" && (variant.value === null || variant.value === undefined))
    ) {
      continue;
    }
    if (variant.kind === "never") {
      continue;
    }
    if (variant.kind === "any" || variant.kind === "unknown" || variant.kind !== "object") {
      warn(
        ctx,
        path,
        "scalar-union-as-json",
        fromDiscriminated
          ? "Discriminated variant is not an object; union emitted as JSON."
          : "Unions of non-object members have no GraphQL representation; emitted as JSON.",
      );
      ctx.scalars.add("JSON");
      return "JSON";
    }
    objects.push(variant);
  }
  if (objects.length === 0) {
    warn(ctx, path, "scalar-union-as-json", "Union has no object members; emitted as JSON.");
    ctx.scalars.add("JSON");
    return "JSON";
  }
  const metaId = identity.metadata.id;
  const effectiveHint = typeof metaId === "string" && metaId !== "" ? metaId : hint;
  const name = prename ?? claimName(ctx, path, effectiveHint, "AnonymousUnion");
  ctx.declared.set(identity, { kind: "union", name });
  if (objects.length === 1 && objects[0] !== undefined) {
    return objectName(objects[0] as ObjectNode, ctx, path, `${name}Member0`).typeName;
  }
  const members = objects.map(
    (member, index) =>
      objectName(member as ObjectNode, ctx, path, `${name}Member${index}`).typeName,
  );
  ctx.unionBlocks.push(`union ${name} = ${members.join(" | ")}`);
  return name;
}

function setField(target: Record<string, SchemaNode>, key: string, value: SchemaNode): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

function mergeObjectFields(left: ObjectNode, right: ObjectNode): Record<string, SchemaNode> {
  const fields: Record<string, SchemaNode> = {};
  for (const key of Object.keys(left.fields)) {
    const field = left.fields[key];
    if (field !== undefined) {
      setField(fields, key, field);
    }
  }
  for (const key of Object.keys(right.fields)) {
    const field = right.fields[key];
    if (field !== undefined) {
      setField(fields, key, field);
    }
  }
  return fields;
}

function intersectionRef(
  node: IntersectionNode,
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
  side: "input" | "output",
): string {
  if (node.left.kind === "object" && node.right.kind === "object") {
    // `ref()` visits every field twice (output side, then input side). The merged
    // object below is synthetic, so it cannot memoize on its own identity: memoize
    // on the intersection node instead, or the merge would emit twice (UM + UM2).
    const memo = ctx.declared.get(node);
    if (memo !== undefined && memo.kind === "object") {
      return side === "input" ? memo.inputName : memo.typeName;
    }
    warn(
      ctx,
      path,
      "intersection-merged",
      "Intersections merge object fields; runtime conflict checks are not representable.",
    );
    const declared = objectName(
      {
        kind: "object",
        fields: mergeObjectFields(node.left, node.right),
        unknownKeys: node.left.unknownKeys,
        metadata: {},
        facets: {},
      },
      ctx,
      path,
      hint,
    );
    ctx.declared.set(node, { kind: "object", ...declared });
    return side === "input" ? declared.inputName : declared.typeName;
  }
  warn(
    ctx,
    path,
    "intersection-as-json",
    "Non-object intersections have no GraphQL representation; emitted as JSON.",
  );
  ctx.scalars.add("JSON");
  return "JSON";
}

function objectName(
  node: ObjectNode,
  ctx: Context,
  path: readonly PropertyKey[],
  hint: string,
): { typeName: string; inputName: string } {
  const existing = ctx.declared.get(node);
  if (existing !== undefined && existing.kind === "object") {
    return existing;
  }
  const id = node.metadata.id;
  const base = typeof id === "string" && id !== "" ? id : hint;
  const typeName = claimName(ctx, path, base, "Anonymous");
  const isOpRoot = ctx.isOperationRoot(typeName);
  const inputName = isOpRoot
    ? `${typeName}Input`
    : claimName(ctx, path, `${typeName}Input`, "AnonymousInput");
  // Ensure we reserve the input name even for operation roots to avoid collision, but not emit input block
  if (isOpRoot && !ctx.names.has(inputName)) ctx.names.add(inputName);
  const declared = { kind: "object" as const, typeName, inputName };
  ctx.declared.set(node, declared);
  buildObjectBlocks(node, ctx, path, declared);
  return declared;
}

function pascalField(parent: string, key: string): string {
  const pascal = pascalCase(key);
  return `${parent}${pascal === "" ? "Field" : pascal}`;
}

function buildObjectBlocks(
  node: ObjectNode,
  ctx: Context,
  path: readonly PropertyKey[],
  declared: { typeName: string; inputName: string },
): void {
  const isOpRoot = ctx.isOperationRoot(declared.typeName);
  const typeExtends = isFederationExtends(node, ctx);
  const typeDirectives = federationTypeDirectives(node, ctx);
  const typePrefix = typeExtends ? "extend type" : "type";
  const typeLines: string[] = [
    ...describe(node.metadata.description),
    `${typePrefix} ${declared.typeName}${typeDirectives} {`,
  ];
  const inputLines: string[] = [
    ...describe(node.metadata.description),
    `input ${declared.inputName} {`,
  ];
  for (const [key, field] of Object.entries(node.fields)) {
    const fieldPath = [...path, key];
    const fieldName = sanitizeName(key, "field");
    if (fieldName !== key) {
      warn(
        ctx,
        fieldPath,
        "name-sanitized",
        `Field ${JSON.stringify(key)} emitted as ${JSON.stringify(fieldName)}.`,
      );
    }
    const hint = pascalField(declared.typeName, key);
    const out = ref(field, ctx, fieldPath, hint, "output");
    const inp = ref(field, ctx, fieldPath, hint, "input");
    const deprecated = deprecation(field.metadata.deprecated);
    const fieldDirectives = federationFieldDirectives(field, ctx);
    const argsStr = isOpRoot ? fieldArgsString(field, ctx, fieldPath, hint) : "";
    const fieldDocs = describe(field.metadata.description).map((line) => `  ${line}`);
    typeLines.push(...fieldDocs);
    typeLines.push(
      `  ${fieldName}${argsStr}: ${out}${nonNull(field, "output") ? "!" : ""}${fieldDirectives}${deprecated}`,
    );
    if (!isOpRoot) {
      let inputLine = `  ${fieldName}: ${inp}${nonNull(field, "input") ? "!" : ""}`;
      if (field.kind === "default") {
        const literal = defaultLiteral(field.value, field);
        if (literal.ok) {
          inputLine += ` = ${literal.text}`;
        } else {
          warn(
            ctx,
            fieldPath,
            "nonserializable-default",
            "Default value is not SDL-serializable and was omitted.",
          );
        }
      }
      if (!inputUndef(field, new Set()) && nullAccepting(field, new Set())) {
        warn(
          ctx,
          fieldPath,
          "required-nullable",
          "GraphQL cannot express required-but-nullable; emitted nullable.",
        );
      }
      inputLines.push(...fieldDocs);
      inputLines.push(`${inputLine}${deprecated}`);
    }
  }
  typeLines.push("}");
  ctx.typeBlocks.push(typeLines.join("\n"));
  if (!isOpRoot) {
    inputLines.push("}");
    ctx.inputBlocks.push(inputLines.join("\n"));
  } else {
    // Still push input but not used? We skip input for operation roots
    // Mark that operation root was emitted
    ctx.operationTypeNames.add(declared.typeName);
  }
}

function resolveRoot(node: SchemaNode): SchemaNode {
  const seen = new Set<SchemaNode>();
  let current = node;
  while (current.kind === "lazy") {
    if (seen.has(current)) {
      throw new Error("Unresolvable lazy cycle at document root.");
    }
    seen.add(current);
    current = current.resolve();
  }
  return current;
}

function toObjectNode(
  input: unknown,
  hint: string,
  ctx: Context,
  path: readonly PropertyKey[],
): ObjectNode | undefined {
  if (isPlainObject(input) && !("node" in input)) {
    // Record<string, Schema>
    const record = input as Record<string, Schema<unknown, unknown>>;
    const fields: Record<string, SchemaNode> = {};
    for (const [k, v] of Object.entries(record)) {
      if (v !== undefined && typeof (v as unknown as { node?: unknown }).node === "object") {
        setField(fields, k, (v as Schema<unknown, unknown>).node);
      } else {
        warn(
          ctx,
          [...path, k],
          "invalid-operation-field",
          `Operation field ${JSON.stringify(k)} is not a Schema and was skipped.`,
        );
      }
    }
    return {
      kind: "object",
      fields,
      unknownKeys: "strip",
      metadata: { id: hint },
      facets: {},
    } as ObjectNode;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "node" in input &&
    typeof (input as { node: unknown }).node === "object"
  ) {
    const schema = input as Schema<unknown, unknown>;
    const resolved = resolveRoot(schema.node);
    if (resolved.kind === "object") return resolved;
    warn(
      ctx,
      path,
      "invalid-operation-root",
      `Operation root ${hint} must be an object; got ${resolved.kind}.`,
    );
    return undefined;
  }
  warn(
    ctx,
    path,
    "invalid-operation-root",
    `Operation root ${hint} must be an object or map of fields.`,
  );
  return undefined;
}

export function sdl(
  types: Record<string, Schema<unknown, unknown>>,
  options?: SdlOptions,
): SdlResult {
  const federationEnabled = options?.federation?.enabled ?? false;
  const federationVersion = options?.federation?.version ?? "2.3";
  const federationImports =
    options?.federation?.import !== undefined
      ? [...options.federation.import]
      : [
          "@key",
          "@shareable",
          "@provides",
          "@requires",
          "@external",
          "@override",
          "@tag",
          "@inaccessible",
        ];

  const isOperationRoot = (name: string): boolean => isOperationRootName(name);

  const ctx: Context = {
    warnings: [],
    declared: new Map(),
    names: new Set(),
    scalars: new Set(),
    enumBlocks: [],
    unionBlocks: [],
    typeBlocks: [],
    inputBlocks: [],
    active: [],
    federationEnabled,
    federationVersion,
    federationImports,
    operationTypeNames: new Set(),
    isOperationRoot,
  };

  // Prepare synthetic operation roots from options.query/mutation/subscription
  const syntheticRoots: Array<{ name: string; node: ObjectNode; path: readonly PropertyKey[] }> =
    [];
  if (options?.query !== undefined) {
    const node = toObjectNode(options.query, "Query", ctx, ["query"]);
    if (node !== undefined) syntheticRoots.push({ name: "Query", node, path: ["query"] });
  }
  if (options?.mutation !== undefined) {
    const node = toObjectNode(options.mutation, "Mutation", ctx, ["mutation"]);
    if (node !== undefined) syntheticRoots.push({ name: "Mutation", node, path: ["mutation"] });
  }
  if (options?.subscription !== undefined) {
    const node = toObjectNode(options.subscription, "Subscription", ctx, ["subscription"]);
    if (node !== undefined)
      syntheticRoots.push({ name: "Subscription", node, path: ["subscription"] });
  }

  for (const [key, schema] of Object.entries(types)) {
    const path = [key];
    const name = claimName(ctx, path, key, "Anonymous");
    const node = resolveRoot(schema.node);
    if (node.kind === "object") {
      if (ctx.declared.has(node)) {
        warn(
          ctx,
          path,
          "duplicate-type",
          `Schema shares a node with an already emitted type; first name wins.`,
        );
        continue;
      }
      // Operation root handling: if name is Query/Mutation/Subscription, treat specially
      if (isOperationRootName(name)) {
        // Directly handle as operation root
        const inputName = `${name}Input`;
        if (!ctx.names.has(inputName)) ctx.names.add(inputName);
        ctx.declared.set(node, { kind: "object", typeName: name, inputName });
        const declared = ctx.declared.get(node);
        if (declared !== undefined && declared.kind === "object") {
          buildObjectBlocks(node, ctx, path, declared);
        }
        continue;
      }
      const inputName = claimName(ctx, path, `${name}Input`, "AnonymousInput");
      ctx.declared.set(node, { kind: "object", typeName: name, inputName });
      const declared = ctx.declared.get(node);
      if (declared !== undefined && declared.kind === "object") {
        buildObjectBlocks(node, ctx, path, declared);
      }
    } else if (node.kind === "enum") {
      if (ctx.declared.has(node)) {
        warn(
          ctx,
          path,
          "duplicate-type",
          `Schema shares a node with an already emitted type; first name wins.`,
        );
        continue;
      }
      enumTypeName(node, node, ctx, path, key, name);
    } else if (node.kind === "union" || node.kind === "discriminatedUnion") {
      if (ctx.declared.has(node)) {
        warn(
          ctx,
          path,
          "duplicate-type",
          `Schema shares a node with an already emitted type; first name wins.`,
        );
        continue;
      }
      const variants =
        node.kind === "union" ? node.variants : node.variants.map((variant) => variant.node);
      unionTypeName(
        node,
        variants,
        ctx,
        path,
        key,
        "output",
        node.kind === "discriminatedUnion",
        name,
      );
    } else if (
      node.kind === "intersection" &&
      node.left.kind === "object" &&
      node.right.kind === "object"
    ) {
      if (ctx.declared.has(node)) {
        warn(
          ctx,
          path,
          "duplicate-type",
          `Schema shares a node with an already emitted type; first name wins.`,
        );
        continue;
      }
      warn(
        ctx,
        path,
        "intersection-merged",
        "Intersections merge object fields; runtime conflict checks are not representable.",
      );
      const inputName = claimName(ctx, path, `${name}Input`, "AnonymousInput");
      ctx.declared.set(node, { kind: "object", typeName: name, inputName });
      const declared = ctx.declared.get(node);
      if (declared !== undefined && declared.kind === "object") {
        buildObjectBlocks(
          {
            kind: "object",
            fields: mergeObjectFields(node.left, node.right),
            unknownKeys: node.left.unknownKeys,
            metadata: node.metadata,
            facets: node.facets,
          },
          ctx,
          path,
          declared,
        );
      }
    } else {
      warn(
        ctx,
        path,
        "root-kind-unsupported",
        `Top-level ${node.kind} schemas have no named GraphQL declaration; skipped.`,
      );
    }
  }

  // Process synthetic operation roots after top-level types to avoid name collisions
  for (const { name, node, path } of syntheticRoots) {
    if (ctx.declared.has(node)) {
      warn(
        ctx,
        path,
        "duplicate-type",
        `Schema shares a node with an already emitted type; first name wins.`,
      );
      continue;
    }
    const typeName = claimName(ctx, path, name, "Anonymous");
    const inputName = `${typeName}Input`;
    if (!ctx.names.has(inputName)) ctx.names.add(inputName);
    ctx.declared.set(node, { kind: "object", typeName, inputName });
    const declared = ctx.declared.get(node);
    if (declared !== undefined && declared.kind === "object") {
      buildObjectBlocks(node, ctx, path, declared);
    }
  }

  const blocks: string[] = [];
  if (federationEnabled) {
    const imports = federationImports.map((imp) => JSON.stringify(imp)).join(", ");
    blocks.push(
      `extend schema @link(url: "https://specs.apollo.dev/federation/v${federationVersion}", import: [${imports}])`,
    );
  }
  if (options?.header !== undefined) blocks.push(options.header);
  for (const scalar of ["BigInt", "DateTime", "JSON"] as const) {
    if (ctx.scalars.has(scalar)) {
      blocks.push(`scalar ${scalar}`);
    }
  }
  blocks.push(...ctx.enumBlocks, ...ctx.unionBlocks, ...ctx.typeBlocks, ...ctx.inputBlocks);
  // Emit schema { query: ... } when operation roots present
  // More robust: check declared typeNames include operation roots
  const opNames = [...ctx.declared.values()]
    .filter((d) => d.kind === "object" && isOperationRootName(d.typeName))
    .map((d) => (d as { typeName: string }).typeName);
  const uniqOps = new Set(opNames);
  if (uniqOps.size > 0) {
    // Avoid duplicate schema block: only if not already emitted? Just emit one.
    const lines = ["schema {"];
    if (uniqOps.has("Query")) lines.push("  query: Query");
    if (uniqOps.has("Mutation")) lines.push("  mutation: Mutation");
    if (uniqOps.has("Subscription")) lines.push("  subscription: Subscription");
    lines.push("}");
    // Only push if not already present? Check if we haven't already added Query etc? We'll add if any.
    // Don't duplicate if already have Query type but no explicit schema block needed – spec allows implicit.
    // But for enterprise proof we want explicit.
    // Only push when options.query etc were provided? For now push whenever operation roots exist.
    // Check if we should push: if uniqOps has at least one, push.
    // But ensure we don't push twice if syntheticRoots already handled? We'll push now.
    // To keep backward compat, only push when options were provided or when types map contained those names?
    // We'll push if original types map had Query/Mutation/Subscription OR options had them.
    const hadExplicitOps =
      Object.keys(types).some((k) => isOperationRootName(k)) ||
      options?.query !== undefined ||
      options?.mutation !== undefined ||
      options?.subscription !== undefined;
    if (hadExplicitOps) blocks.push(lines.join("\n"));
  }
  const seenWarnings = new Set<string>();
  const warnings: GraphqlWarning[] = [];
  for (const warning of ctx.warnings) {
    const key = `${warning.code}\n${warning.path.map(String).join("\n")}\n${warning.message}`;
    if (!seenWarnings.has(key)) {
      seenWarnings.add(key);
      warnings.push(warning);
    }
  }
  return { sdl: `${blocks.join("\n\n")}\n`, warnings };
}
