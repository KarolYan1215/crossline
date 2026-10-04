/**
 * What the runtime's strict structured-output mode will accept, checked before a schema ever reaches it.
 *
 * Strict mode fails the *whole* `thread/start` (or the turn) on a schema it dislikes, with an error that names nothing the
 * reader can act on — this is how the weekly flywheel could not run for weeks. The rules below are the ones that bit us or
 * that the provider documents as hard limits: an object lists every property in `required` and forbids extras, unions are
 * `anyOf`, nesting and size stay inside the limits. `structuredOutputProblems` returns what is wrong, by JSON path.
 */
const MAX_DEPTH = 8;            // the provider's limit is 10; leave room for the wrapper the runtime adds
const MAX_PROPERTIES = 2_000;   // the limit is 5,000; a schema near it also decodes slowly
const MAX_ENUM_VALUES = 500;
const FORBIDDEN_KEYWORDS = ["oneOf", "allOf", "not", "if", "then", "else", "patternProperties", "dependentSchemas"];

export function structuredOutputProblems(schema: unknown): string[] {
  const problems: string[] = [];
  let properties = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (depth > MAX_DEPTH) { problems.push(`${path}: nested deeper than ${MAX_DEPTH} levels`); return; }
    for (const keyword of FORBIDDEN_KEYWORDS) if (keyword in record) problems.push(`${path}: "${keyword}" is not supported (use anyOf)`);
    if (Array.isArray(record.enum) && record.enum.length > MAX_ENUM_VALUES) problems.push(`${path}: ${record.enum.length} enum values`);
    if (Array.isArray(record.anyOf)) record.anyOf.forEach((branch, index) => walk(branch, `${path}.anyOf[${index}]`, depth + 1));
    if (record.type === "object") {
      const props = record.properties as Record<string, unknown> | undefined;
      if (!props || typeof props !== "object") { problems.push(`${path}: object without properties`); return; }
      const keys = Object.keys(props);
      properties += keys.length;
      if (record.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
      const required = Array.isArray(record.required) ? record.required as string[] : [];
      for (const key of keys) if (!required.includes(key)) problems.push(`${path}.${key}: not in required (strict mode needs every property required; use anyOf with null for "optional")`);
      for (const key of required) if (!keys.includes(key)) problems.push(`${path}: required lists unknown property "${key}"`);
      for (const key of keys) walk(props[key], `${path}.${key}`, depth + 1);
    }
    if (record.type === "array") {
      if (record.items === undefined) problems.push(`${path}: array without items`);
      else walk(record.items, `${path}[]`, depth + 1);
    }
  };
  if ((schema as { type?: unknown } | null)?.type !== "object") problems.push("$: the root must be an object (a union at the root is refused)");
  walk(schema, "$", 1);
  if (properties > MAX_PROPERTIES) problems.push(`$: ${properties} properties in total`);
  return problems;
}
