/**
 * Mends the brackets of a long JSON answer, and nothing else (2026-11-14).
 *
 * On the developer's model (DeepSeek-V4.1-Flash) the portrait writer's single ~12k-token answer came back unparseable about one
 * attempt in nine, and on replay 8 three times in a row. Every recorded failure had the content whole and one bracket wrong: a stray
 * `}` that closed the root early with the rest of the report still to come, or one `}` missing. A repair turn regenerated the whole
 * report to fix one character. Here the brackets are put right with the output schema as the map: a closer that has nothing to close
 * (or would close the root before the answer ends) is dropped, a key that the open object does not have but an enclosing one does
 * closes the objects in between, and what is still open at the end is closed. Strings, numbers and keys are copied as they came; an
 * unterminated string, or more than a handful of edits, gives up. What comes out is validated as any other answer.
 */

type SchemaNode = Record<string, unknown> | undefined;
type Open = { closer: "}" | "]"; schema: SchemaNode };

const MAX_EDITS = 4;

const lastIndex = <T,>(items: T[], test: (item: T, index: number) => boolean): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index]!, index)) return index;
  return -1;
};

const asNode = (value: unknown): SchemaNode => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const propertiesOf = (schema: SchemaNode) => asNode(schema?.properties);
const childOf = (schema: SchemaNode, key: string | undefined): SchemaNode =>
  key === undefined ? asNode(schema?.items) : asNode(propertiesOf(schema)?.[key]);

/** The answer with its brackets mended, or `undefined` when it cannot be mended by bracket edits alone. */
export function repairJsonBrackets(text: string, schema: unknown, maxEdits = MAX_EDITS): string | undefined {
  const out: string[] = [];
  const stack: Open[] = [];
  let edits = 0;
  // Inside an object: whether the next string is a key, and the key the next value belongs to.
  let expectKey = false;
  let pendingKey: string | undefined;
  let rootDone = false;
  const opened = (closer: "}" | "]") => {
    const parent = stack.at(-1);
    const schemaNode = parent ? childOf(parent.schema, parent.closer === "}" ? pendingKey : undefined) : asNode(schema);
    stack.push({ closer, schema: schemaNode });
    expectKey = closer === "}";
    pendingKey = undefined;
  };
  const afterClose = () => { expectKey = false; if (!stack.length) rootDone = true; };

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "\"") {
      let end = at + 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "\\") { end += 1; continue; }
        if (text[end] === "\"") break;
      }
      if (end >= text.length) return undefined;
      const literal = text.slice(at, end + 1);
      const top = stack.at(-1);
      if (top?.closer === "}" && expectKey) {
        let key: string;
        try { key = JSON.parse(literal) as string; } catch { return undefined; }
        const known = propertiesOf(top.schema);
        if (known && !(key in known)) {
          // A key this object does not have but an enclosing object does: the objects in between were left open.
          const home = lastIndex(stack, (item, index) => index < stack.length - 1 && item.closer === "}" && Boolean(propertiesOf(item.schema)) && key in propertiesOf(item.schema)!);
          // Only after a comma: the closers go before it, so the key follows them as the next member further out.
          let commaAt = out.length - 1;
          while (commaAt >= 0 && !out[commaAt]!.trim()) commaAt -= 1;
          if (home >= 0 && out[commaAt] === ",") {
            const closers = stack.splice(home + 1).reverse().map((item) => item.closer);
            edits += closers.length;
            if (edits > maxEdits) return undefined;
            out.splice(commaAt, 0, ...closers);
          }
        }
        pendingKey = key;
        expectKey = false;
      }
      out.push(literal);
      at = end;
      continue;
    }
    if (char === "{" || char === "[") {
      if (rootDone) return undefined;
      out.push(char);
      opened(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      const top = stack.at(-1);
      const restHasContent = /\S/.test(text.slice(at + 1));
      if (top?.closer === char && !(stack.length === 1 && restHasContent)) {
        stack.pop();
        out.push(char);
        afterClose();
        continue;
      }
      const match = lastIndex(stack, (item) => item.closer === char);
      if (top && top.closer !== char && match >= 0 && !(match === 0 && restHasContent)) {
        // The containers above the one this closes were left open: close them first.
        const closers = stack.splice(match).reverse().map((item) => item.closer);
        edits += closers.length - 1;
        if (edits > maxEdits) return undefined;
        out.push(...closers);
        afterClose();
        continue;
      }
      // Nothing to close, or it would end the answer with more still to come: a stray closer.
      edits += 1;
      if (edits > maxEdits) return undefined;
      continue;
    }
    if (char === ",") {
      if (rootDone) return undefined;
      out.push(char);
      if (stack.at(-1)?.closer === "}") expectKey = true;
      continue;
    }
    if (char === ":") { out.push(char); continue; }
    if (/\s/.test(char)) { out.push(char); continue; }
    // A number or a literal.
    if (rootDone || !stack.length) return undefined;
    out.push(char);
  }
  // At the end at most one container may still be open, and only after an answer that ended on a closer: a model that finished
  // but missed the last brace. An answer cut off mid-way ends on a value or a comma with several levels open, and is not passed off as whole.
  if (stack.length) {
    if (stack.length > 1 || !/[}\]]\s*$/.test(text)) return undefined;
    edits += stack.length;
    if (edits > maxEdits) return undefined;
    out.push(...stack.reverse().map((item) => item.closer));
  }
  if (!edits) return undefined;
  const mended = out.join("");
  try { JSON.parse(mended); return mended; } catch { return undefined; }
}
