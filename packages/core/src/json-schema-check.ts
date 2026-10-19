/**
 * A structural check of a value against the subset of JSON Schema the Skills' schemas use, kept apart from the conformance cases so the
 * validators can use it without importing every schema (2026-10-19).
 */
const typeOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array"
  : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;

/**
 * Whether a value keeps to a schema, for the subset of JSON Schema our schemas use (type, properties/required/additionalProperties,
 * items, enum, const, anyOf, string and array lengths, numeric bounds, pattern). Lengths count characters, as the validators do.
 */
export function jsonSchemaProblems(value: unknown, schema: unknown, path = "$"): string[] {
  const node = schema as Record<string, unknown> | null;
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf.map((branch) => jsonSchemaProblems(value, branch, path));
    return branches.some((problems) => !problems.length) ? [] : [`${path}: matches no anyOf branch (${branches.map((problems) => problems[0]).join(" | ")})`];
  }
  const actual = typeOf(value);
  if (node.type !== undefined) {
    const allowed = Array.isArray(node.type) ? node.type as string[] : [node.type as string];
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) return [`${path}: expected ${allowed.join("|")}, got ${actual}`];
  }
  const problems: string[] = [];
  if (Array.isArray(node.enum) && !node.enum.includes(value as never)) problems.push(`${path}: not one of ${JSON.stringify(node.enum).slice(0, 120)}`);
  if ("const" in node && node.const !== value) problems.push(`${path}: must be ${JSON.stringify(node.const)}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof node.minLength === "number" && length < node.minLength) problems.push(`${path}: ${length} characters, at least ${node.minLength}`);
    if (typeof node.maxLength === "number" && length > node.maxLength) problems.push(`${path}: ${length} characters, at most ${node.maxLength}`);
    if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) problems.push(`${path}: does not match ${node.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) problems.push(`${path}: below ${node.minimum}`);
    if (typeof node.maximum === "number" && value > node.maximum) problems.push(`${path}: above ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) problems.push(`${path}: ${value.length} items, at least ${node.minItems}`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) problems.push(`${path}: ${value.length} items, at most ${node.maxItems}`);
    value.forEach((item, index) => problems.push(...jsonSchemaProblems(item, node.items, `${path}[${index}]`)));
  }
  if (actual === "object" && node.properties && typeof node.properties === "object") {
    const props = node.properties as Record<string, unknown>;
    const object = value as Record<string, unknown>;
    for (const key of Array.isArray(node.required) ? node.required as string[] : []) if (!(key in object)) problems.push(`${path}.${key}: missing`);
    if (node.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in props)) problems.push(`${path}.${key}: not allowed`);
    for (const [key, child] of Object.entries(props)) if (key in object) problems.push(...jsonSchemaProblems(object[key], child, `${path}.${key}`));
  }
  return problems;
}


/**
 * An answer with its enum slips repaired the way a person would (2026-10-19, the owner asked whether a cheaper model's one failure could
 * be tolerated): a value that matches an allowed one but for case or spaces takes it, and an object in a list whose only problems are
 * values outside an enum (「love: "medium"」 where only high and low exist) is left out of the list rather than failing the whole answer.
 * Anything else is left for the validator to send back.
 */
export function dropEnumSlips(value: unknown, schema: unknown): unknown {
  const node = schema as Record<string, unknown> | null;
  if (!node || typeof node !== "object") return value;
  if (Array.isArray(node.anyOf)) {
    const branch = node.anyOf.find((option) => !jsonSchemaProblems(value, option).length)
      ?? node.anyOf.find((option) => { const type = (option as Record<string, unknown>)?.type; return type === typeOf(value) || (Array.isArray(type) && type.includes(typeOf(value))); });
    return branch ? dropEnumSlips(value, branch) : value;
  }
  if (typeof value === "string" && Array.isArray(node.enum) && !node.enum.includes(value)) {
    const near = node.enum.find((option) => typeof option === "string" && option.toLowerCase() === value.trim().toLowerCase());
    return near ?? value;
  }
  if (Array.isArray(value) && node.items) {
    const items = value.map((item) => dropEnumSlips(item, node.items));
    const onlyEnum = (item: unknown) => { const problems = jsonSchemaProblems(item, node.items); return problems.length > 0 && problems.every((problem) => problem.includes(": not one of ")); };
    return typeOf(items[0]) === "object" ? items.filter((item) => !onlyEnum(item)) : items;
  }
  if (typeOf(value) === "object" && node.properties && typeof node.properties === "object") {
    const props = node.properties as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, key in props ? dropEnumSlips(child, props[key]) : child]));
  }
  return value;
}
