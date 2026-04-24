import { getSourceDocumentsByIds } from "@/lib/db/queries";
import { embedQuery } from "./indexing";
import { chunkText } from "./chunk";
import { extractPdfTextFromUrl } from "./pdf";
import { queryQdrant } from "./qdrant";

const ragTopK = Number(process.env.RAG_TOP_K ?? 6);
const attachmentChunkSize = Number(process.env.RAG_ATTACHMENT_CHUNK_SIZE ?? 1200);
const attachmentChunkOverlap = Number(
  process.env.RAG_ATTACHMENT_CHUNK_OVERLAP ?? 100
);
const attachmentMaxChunksPerPdf = Number(
  process.env.RAG_ATTACHMENT_MAX_CHUNKS_PER_PDF ?? 3
);

export async function retrieveRelevantPdfContext({
  userId,
  chatId,
  query,
}: {
  userId: string;
  chatId?: string;
  query: string;
}) {
  // #region agent log
  fetch("http://127.0.0.1:7591/ingest/d5e14d6a-003d-43d9-b2e4-2b835abdcd83", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "f5d13d",
    },
    body: JSON.stringify({
      sessionId: "f5d13d",
      runId: "pre-fix",
      hypothesisId: "H4",
      location: "lib/ai/rag/retrieval.ts",
      message: "retrieveRelevantPdfContext start",
      data: { hasChatId: Boolean(chatId), queryLength: query.trim().length },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  const question = query.trim();
  if (!question) {
    return { context: "", citations: [] as string[] };
  }

  const vector = await embedQuery(question);
  let matches = await queryQdrant({
    vector,
    userId,
    chatId,
    limit: ragTopK,
  });

  if (matches.length === 0 && chatId) {
    matches = await queryQdrant({
      vector,
      userId,
      limit: ragTopK,
    });
  }

  if (matches.length === 0) {
    // #region agent log
    fetch("http://127.0.0.1:7591/ingest/d5e14d6a-003d-43d9-b2e4-2b835abdcd83", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "f5d13d",
      },
      body: JSON.stringify({
        sessionId: "f5d13d",
        runId: "pre-fix",
        hypothesisId: "H4",
        location: "lib/ai/rag/retrieval.ts",
        message: "retrieveRelevantPdfContext no matches",
        data: { hasChatId: Boolean(chatId) },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return { context: "", citations: [] as string[] };
  }

  let documents: Awaited<ReturnType<typeof getSourceDocumentsByIds>> = [];
  try {
    documents = await getSourceDocumentsByIds({
      ids: [...new Set(matches.map((match) => match.documentId))],
      userId,
    });
  } catch {
    documents = [];
  }
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));

  const context = matches
    .map((match, index) => {
      const document = documentsById.get(match.documentId);
      const sourceName = document?.filename ?? match.filename ?? "Unknown PDF";
      return `Source ${index + 1} (${sourceName}, pages ${match.pageStart}-${match.pageEnd}):\n${match.content}`;
    })
    .join("\n\n");

  const citations = matches.map((match) => {
    const document = documentsById.get(match.documentId);
    const sourceName = document?.filename ?? match.filename ?? "Unknown PDF";
    return `${sourceName} (pages ${match.pageStart}-${match.pageEnd})`;
  });

  return {
    context,
    citations,
  };
}

export async function retrieveAttachedPdfContext(
  attachments: Array<{ url: string; name: string }>
) {
  // #region agent log
  fetch("http://127.0.0.1:7591/ingest/d5e14d6a-003d-43d9-b2e4-2b835abdcd83", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "f5d13d",
    },
    body: JSON.stringify({
      sessionId: "f5d13d",
      runId: "pre-fix",
      hypothesisId: "H5",
      location: "lib/ai/rag/retrieval.ts",
      message: "retrieveAttachedPdfContext start",
      data: { attachmentCount: attachments.length },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (attachments.length === 0) {
    return { context: "", citations: [] as string[] };
  }

  const results = await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const text = await extractPdfTextFromUrl(attachment.url);
        const chunks = chunkText({
          text,
          chunkSize: attachmentChunkSize,
          overlap: attachmentChunkOverlap,
        }).slice(0, attachmentMaxChunksPerPdf);

        return {
          name: attachment.name,
          chunks,
        };
      } catch {
        return null;
      }
    })
  );

  const valid = results.filter(
    (
      item
    ): item is {
      name: string;
      chunks: Array<{
        chunkIndex: number;
        content: string;
        pageStart: number;
        pageEnd: number;
      }>;
    } => item !== null && item.chunks.length > 0
  );

  if (valid.length === 0) {
    // #region agent log
    fetch("http://127.0.0.1:7591/ingest/d5e14d6a-003d-43d9-b2e4-2b835abdcd83", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "f5d13d",
      },
      body: JSON.stringify({
        sessionId: "f5d13d",
        runId: "pre-fix",
        hypothesisId: "H5",
        location: "lib/ai/rag/retrieval.ts",
        message: "retrieveAttachedPdfContext no valid parsed PDFs",
        data: { attachmentCount: attachments.length },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return { context: "", citations: [] as string[] };
  }

  const context = valid
    .flatMap((pdf) =>
      pdf.chunks.map(
        (chunk, index) =>
          `Attached Source ${index + 1} (${pdf.name}, pages ${chunk.pageStart}-${chunk.pageEnd}):\n${chunk.content}`
      )
    )
    .join("\n\n");

  const citations = valid.flatMap((pdf) =>
    pdf.chunks.map(
      (chunk) => `${pdf.name} (pages ${chunk.pageStart}-${chunk.pageEnd})`
    )
  );

  return { context, citations };
}
