/** "1 file", "3 files": a count with the word in the right number. */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}
