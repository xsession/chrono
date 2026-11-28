// A small YAML reader for CI configuration files (workflow_dispatch inputs,
// .gitlab-ci.yml variables, bitbucket-pipelines.yml custom pipelines).
//
// It handles block mappings and sequences, "- key: value" items, quoted and
// plain scalars, simple flow lists ([a, b]) and maps ({a: 1}), block
// scalars (| and >) and comments. Anchors, aliases, tags and multi-document
// files are not interpreted; what it cannot read becomes a string or is
// skipped, never an exception, because these files only feed a form.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line { indent: number; text: string }

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) { if (char === quote && line[index - 1] !== "\\") quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of body) {
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === "[" || char === "{") depth++;
    if (char === "]" || char === "}") depth--;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith("[") && text.endsWith("]")) return splitFlow(text.slice(1, -1)).map(parseScalar);
  if (text.startsWith("{") && text.endsWith("}")) {
    const result: Record<string, YamlValue> = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      const colon = part.indexOf(":");
      if (colon > 0) result[String(parseScalar(part.slice(0, colon)))] = parseScalar(part.slice(colon + 1));
    }
    return result;
  }
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Position of the ": " (or trailing ":") that ends a mapping key, outside quotes. */
function keyEnd(text: string): number {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if ((char === "'" || char === '"') && index === 0) { quote = char; continue; }
    if (char === ":" && (index === text.length - 1 || text[index + 1] === " ")) return index;
    if (char === "[" || char === "{") return -1;
  }
  return -1;
}

export function parseYaml(source: string): YamlValue {
  const lines: Line[] = [];
  const raw = source.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  // Block scalars are folded into one line here, before indentation parsing.
  for (let index = 0; index < raw.length; index++) {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw[index])) { if (lines.length) break; continue; }
    const text = stripComment(raw[index]).replace(/\s+$/, "");
    if (!text.trim()) continue;
    const indent = text.length - text.trimStart().length;
    const block = /^(.*?:\s*|.*?-\s+)([|>])[-+]?\d*$/.exec(text);
    if (block) {
      const collected: string[] = [];
      let blockIndent = -1;
      while (index + 1 < raw.length) {
        const next = raw[index + 1].replace(/\t/g, "  ");
        if (next.trim() === "") { collected.push(""); index++; continue; }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        if (blockIndent < 0) blockIndent = nextIndent;
        collected.push(next.slice(Math.min(blockIndent, nextIndent)));
        index++;
      }
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
      const value = block[2] === "|" ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ");
      lines.push({ indent, text: `${block[1].trimStart()}${JSON.stringify(value)}` });
      continue;
    }
    lines.push({ indent, text: text.trimStart() });
  }
  const [value] = parseBlock(lines, 0, lines.length ? lines[0].indent : 0);
  return value;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) return [null, start];
  if (lines[start].text.startsWith("- ") || lines[start].text === "-") return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && (lines[index].text.startsWith("- ") || lines[index].text === "-")) {
    const rest = lines[index].text === "-" ? "" : lines[index].text.slice(2).trimStart();
    const itemIndent = indent + (lines[index].text.length - rest.length);
    if (!rest) {
      const next = lines[index + 1];
      if (next && next.indent > indent) { const [value, after] = parseBlock(lines, index + 1, next.indent); items.push(value); index = after; }
      else { items.push(null); index++; }
      continue;
    }
    if (keyEnd(rest) > 0 || rest.startsWith("- ")) {
      // "- key: value" opens a mapping (or a nested list) at the item's column.
      const replaced = [...lines];
      replaced[index] = { indent: itemIndent, text: rest };
      const [value, after] = parseBlock(replaced, index, itemIndent);
      items.push(value);
      index = after;
      continue;
    }
    items.push(parseScalar(rest));
    index++;
  }
  return [items, index];
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, YamlValue>, number] {
  const result: Record<string, YamlValue> = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const text = lines[index].text;
    if (text.startsWith("- ")) break;
    const end = keyEnd(text);
    if (end <= 0) { index++; continue; } // not a mapping entry: skip it
    const key = String(parseScalar(text.slice(0, end)));
    const rest = text.slice(end + 1).trim();
    if (rest && !rest.startsWith("&") && !rest.startsWith("*")) { result[key] = parseScalar(rest); index++; continue; }
    const next = lines[index + 1];
    if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))) {
      const [value, after] = parseBlock(lines, index + 1, next.indent);
      result[key] = value;
      index = after;
    } else {
      result[key] = null;
      index++;
    }
  }
  return [result, index];
}
