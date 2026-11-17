/**
 * Mends the brackets of a long JSON answer, and the quotes inside its texts, and nothing else (2026-11-14, quotes 2026-11-16).
 *
 * On the developer's model (DeepSeek-V4.1-Flash) the portrait writer's single ~12k-token answer came back unparseable about one
 * attempt in nine, and on replay 8 three times in a row. Every recorded failure had the content whole and one bracket wrong: a stray
 * `}` that closed the root early with the rest of the report still to come, or one `}` missing. A repair turn regenerated the whole
 * report to fix one character. Here the brackets are put right with the output schema as the map: a closer that has nothing to close
 * (or would close the root before the answer ends) is dropped, a key that the open object does not have but an enclosing one does
 * closes the objects in between, and what is still open at the end is closed. Strings, numbers and keys are copied as they came; an
 * unterminated string, or more than a handful of edits, gives up. What comes out is validated as any other answer.
 *
 * On replay 16 the writer failed three answers in a row on the same model (about 9k tokens each, the size of a whole report, so not
 * cut off) and bracket edits could not mend them. The raw answers were not kept; the other common way a model's JSON breaks is a
 * quote inside a text left unescaped (「他说"好"」), so a quote that the JSON could not go on after is escaped as text. The other
 * slips a parser refuses and a reader would not notice are mended the same way, none of them changing a word: a line break or tab
 * typed raw inside a text (escaped), a backslash before a letter JSON has no escape for (escaped), a comma before a closer (dropped),
 * and a sentence before the object or after it (dropped, when it holds no bracket or quote: a second object is never glued on).
 */

type SchemaNode = Record<string, unknown> | undefined;
type Open = { closer: "}" | "]"; schema: SchemaNode };

const MAX_EDITS = 4;
/** Quotes inside a text left unescaped (「他说"好"」): each one escaped is an edit of its own budget, since a report quotes often. */
const MAX_QUOTE_EDITS = 24;

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
  let quoteEdits = 0;
  // Slips mended without changing a word (raw line breaks, stray backslashes, trailing commas, a sentence around the object).
  let textEdits = 0;
  const opened = (closer: "}" | "]") => {
    const parent = stack.at(-1);
    const schemaNode = parent ? childOf(parent.schema, parent.closer === "}" ? pendingKey : undefined) : asNode(schema);
    stack.push({ closer, schema: schemaNode });
    expectKey = closer === "}";
    pendingKey = undefined;
  };
  const afterClose = () => { expectKey = false; if (!stack.length) rootDone = true; };

  // A sentence before the object (「以下是报告：」) holds no bracket or quote of its own.
  const first = text.indexOf("{");
  if (first > 0 && text.slice(0, first).trim()) {
    if (/[{}[\]"]/.test(text.slice(0, first))) return undefined;
    textEdits += 1;
  }
  for (let at = Math.max(0, first); at < text.length; at += 1) {
    const char = text[at]!;
    // After the object only a sentence may follow (「希望有帮助」, a closing fence): dropped. Brackets or quotes there are refused.
    if (rootDone && /\S/.test(char)) {
      if (/[{}[\]"]/.test(text.slice(at))) return undefined;
      textEdits += 1;
      break;
    }
    if (char === "\"") {
      const top = stack.at(-1);
      const isKey = top?.closer === "}" && expectKey;
      // A quote ends the string only where the JSON can go on: a key's before `:`, a value's before `,`, a closer or the end.
      // Anywhere else it is a quote inside the text that was not escaped, and it is escaped (2026-11-16).
      let literal = "\"";
      let end = at + 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "\\") {
          const escaped = text[end + 1] ?? "";
          if (/^["\\/bfnrt]$/.test(escaped) || (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(end + 2, end + 6)))) {
            literal += text.slice(end, end + 2);
            end += 1;
            continue;
          }
          // A backslash JSON has no escape for (`\'`, `\x`, a Windows path): kept as the character it reads as.
          textEdits += 1;
          literal += "\\\\";
          continue;
        }
        if (text.charCodeAt(end) < 0x20) {
          // A line break or tab typed raw inside a text.
          textEdits += 1;
          literal += JSON.stringify(text[end]).slice(1, -1);
          continue;
        }
        if (text[end] === "\"") {
          let after = end + 1;
          while (after < text.length && /\s/.test(text[after]!)) after += 1;
          const next = text[after];
          if (isKey ? next === ":" : next === undefined || next === "," || next === "}" || next === "]") break;
          quoteEdits += 1;
          if (quoteEdits > MAX_QUOTE_EDITS) return undefined;
          literal += "\\\"";
          continue;
        }
        literal += text[end];
      }
      if (end >= text.length) return undefined;
      literal += "\"";
      if (isKey) {
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
      // A comma before a closer is dropped.
      let commaAt = out.length - 1;
      while (commaAt >= 0 && !out[commaAt]!.trim()) commaAt -= 1;
      if (out[commaAt] === ",") { out.splice(commaAt, 1); textEdits += 1; }
      const top = stack.at(-1);
      // Only brackets and quotes are more of the answer; a sentence after it is not.
      const restHasContent = /[{}[\]"]/.test(text.slice(at + 1));
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
  if (!edits && !quoteEdits && !textEdits) return undefined;
  const mended = out.join("");
  try { JSON.parse(mended); return mended; } catch { return undefined; }
}

/**
 * Whether an answer that did not parse ends by going round in a loop: the same passage, again and again, until the output ran out.
 * Its last 80 characters found twice more in the 6000 before them (three times in all) is a loop, which a repair turn is told plainly.
 */
export function looksLooping(text: string): boolean {
  if (text.length < 2000) return false;
  const probe = text.slice(-80);
  const window = text.slice(-6000, -80);
  let count = 0;
  for (let at = window.indexOf(probe); at >= 0; at = window.indexOf(probe, at + 1)) count += 1;
  return count >= 2;
}
