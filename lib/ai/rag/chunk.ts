export type TextChunk = {
  chunkIndex: number;
  content: string;
  pageStart: number;
  pageEnd: number;
};

export function chunkText({
  text,
  chunkSize,
  overlap,
}: {
  text: string;
  chunkSize: number;
  overlap: number;
}): TextChunk[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    const content = normalized.slice(start, end).trim();
    if (content) {
      chunks.push({
        chunkIndex: index,
        content,
        pageStart: 1,
        pageEnd: 1,
      });
      index++;
    }

    if (end === normalized.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
