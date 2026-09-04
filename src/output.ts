export type TextSliceOptions = {
  head?: number;
  tail?: number;
  contains?: string;
  maxChars?: number;
};

export type TextSliceResult = {
  content: string;
  totalChars: number;
  returnedChars: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  selection: "full" | "head" | "tail" | "contains";
  omittedChars: number;
};

export function parsePositiveInteger(
  raw: string | undefined,
  fallback: number | undefined,
  label: string,
): number | undefined {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function sliceText(content: string, options: TextSliceOptions): TextSliceResult {
  if (options.head && options.tail) throw new Error("Use only one of --head or --tail");
  const sourceLines = content.split("\n");
  let lines = sourceLines;
  let selection: TextSliceResult["selection"] = "full";

  if (options.contains) {
    const needle = options.contains.toLowerCase();
    lines = sourceLines.filter((line) => line.toLowerCase().includes(needle));
    selection = "contains";
  }
  if (options.head) {
    lines = lines.slice(0, options.head);
    selection = "head";
  }
  else if (options.tail) {
    lines = lines.slice(-options.tail);
    selection = "tail";
  }

  let selected = lines.join("\n");
  if (options.maxChars && selected.length > options.maxChars) {
    selected = selection === "tail"
      ? selected.slice(-options.maxChars)
      : selected.slice(0, options.maxChars);
  }

  return {
    content: selected,
    totalChars: content.length,
    returnedChars: selected.length,
    totalLines: sourceLines.length,
    returnedLines: selected ? selected.split("\n").length : 0,
    truncated: selected.length < content.length,
    selection,
    omittedChars: Math.max(0, content.length - selected.length),
  };
}

export function omitEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => omitEmpty(item)).filter((item) => item !== undefined) as T;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, omitEmpty(item)] as const)
    .filter(([, item]) => {
      if (item === undefined || item === null || item === "") return false;
      if (Array.isArray(item) && item.length === 0) return false;
      if (item && typeof item === "object" && Object.keys(item).length === 0) return false;
      return true;
    });
  return Object.fromEntries(entries) as T;
}

export function paginate<T>(items: T[], limit: number, offset: number) {
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < items.length ? offset + page.length : null;
  return {
    items: page,
    pagination: {
      total: items.length,
      returned: page.length,
      offset,
      hasMore: nextOffset !== null,
      nextOffset,
    },
  };
}
