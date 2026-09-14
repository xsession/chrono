export type ConflictBlockChoice = "current" | "incoming" | "bothCurrent" | "bothIncoming";

export type MarkerBlock = {
  start: number;
  end: number;
  current: string;
  incoming: string;
};

export function parseConflictBlocks(text: string): MarkerBlock[] {
  const pattern = /^<<<<<<<[^\n]*\r?\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\n]*\r?\n[\s\S]*?)?^=======[^\n]*\r?\n([\s\S]*?)^>>>>>>>[^\n]*(?:\r?\n|$)/gm;
  const blocks: MarkerBlock[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    blocks.push({ start, end: start + match[0].length, current: match[1], incoming: match[2] });
  }
  return blocks;
}

function joinBoth(first: string, second: string): string {
  if (!first || !second || first.endsWith("\n") || second.startsWith("\n")) return first + second;
  return `${first}\n${second}`;
}

export function replaceConflictBlock(text: string, index: number, choice: ConflictBlockChoice): string {
  const block = parseConflictBlocks(text)[index];
  if (!block) return text;
  const replacement = choice === "current" ? block.current
    : choice === "incoming" ? block.incoming
    : choice === "bothCurrent" ? joinBoth(block.current, block.incoming)
    : joinBoth(block.incoming, block.current);
  return `${text.slice(0, block.start)}${replacement}${text.slice(block.end)}`;
}
