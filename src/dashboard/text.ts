import { clean } from "./data.ts";

export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const cellWidth = (char: string): number => {
  // Matching the ZWJ and variation selector individually is exactly what
  // grapheme width measurement needs here.
  // eslint-disable-next-line no-misleading-character-class
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(char)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(char)) return 2;
  const cp = char.codePointAt(0)!;
  return cp >= 0x1100
    && (cp <= 0x115f
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe10 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x20000 && cp <= 0x3ffff))
    ? 2
    : 1;
};
// Printable ASCII needs neither sanitising nor grapheme segmentation: one char, one cell.
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

export function fit(value: unknown, width: number): string {
  if (typeof value === "string" && PLAIN_ASCII.test(value))
    return value.length >= width
      ? value.slice(0, Math.max(0, width))
      : value + " ".repeat(width - value.length);
  let result = "",
    cells = 0;
  for (const { segment } of graphemes.segment(clean(value))) {
    const size = cellWidth(segment);
    if (cells + size > width) break;
    result += segment;
    cells += size;
  }
  return result + " ".repeat(Math.max(0, width - cells));
}
export function wrap(value: unknown, width: number): string[] {
  const lines: string[] = [];
  let line = "",
    cells = 0;
  for (const { segment } of graphemes.segment(clean(value))) {
    const size = cellWidth(segment);
    if (cells + size > width && line) {
      lines.push(line);
      line = "";
      cells = 0;
    }
    line += size > width ? "�" : segment;
    cells += Math.min(size, width);
  }
  lines.push(line);
  return lines;
}
/**
 * Like {@link fit}, for text that already carries SGR color sequences: the
 * sequences are kept and only visible cells count toward the width.
 */
export function fitAnsi(value: string, width: number): string {
  let result = "",
    cells = 0;
  // eslint-disable-next-line no-control-regex -- SGR sequences are matched on purpose.
  for (const part of value.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      result += part;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      const size = cellWidth(segment);
      if (cells + size > width) return `${result}\x1b[0m`;
      result += segment;
      cells += size;
    }
  }
  return result + " ".repeat(Math.max(0, width - cells));
}
