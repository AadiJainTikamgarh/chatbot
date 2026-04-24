import { embed, embedMany } from "ai";
import {
  createSourceDocument,
  saveDocumentChunks,
  updateSourceDocumentStatus,
} from "@/lib/db/queries";
import { generateUUID } from "@/lib/utils";
import { getEmbeddingModel, getFallbackEmbeddingModel } from "../providers";
import { chunkText } from "./chunk";
import { extractPdfTextFromBuffer, extractPdfTextFromUrl } from "./pdf";
import { ensureQdrantCollection, upsertQdrantPoints } from "./qdrant";

const defaultChunkSize = Number(process.env.RAG_CHUNK_SIZE ?? 1000);
const defaultChunkOverlap = Number(process.env.RAG_CHUNK_OVERLAP ?? 200);

export async function indexPdfDocument({
  userId,
  chatId,
  filename,
  blobUrl,
  mimeType,
  pdfBuffer,
}: {
  userId: string;
  chatId?: string;
  filename: string;
  blobUrl: string;
  mimeType: string;
  pdfBuffer?: ArrayBuffer;
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
      hypothesisId: "H2",
      location: "lib/ai/rag/indexing.ts",
      message: "indexPdfDocument start",
      data: {
        mimeType,
        hasPdfBuffer: Boolean(pdfBuffer),
        blobUrlHost: (() => {
          try {
            return new URL(blobUrl).host;
          } catch {
            return "invalid-url";
          }
        })(),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  const documentId = generateUUID();
  let sourceDocumentCreated = false;
  try {
    await createSourceDocument({
      id: documentId,
      userId,
      chatId,
      filename,
      blobUrl,
      mimeType,
    });
    sourceDocumentCreated = true;
  } catch (error) {
    console.error("Source document metadata insert failed:", error);
  }

  try {
    const text = pdfBuffer
      ? await extractPdfTextFromBuffer(pdfBuffer)
      : await extractPdfTextFromUrl(blobUrl);
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
        hypothesisId: "H2",
        location: "lib/ai/rag/indexing.ts",
        message: "PDF text extracted",
        data: { textLength: text.length },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const chunks = chunkText({
      text,
      chunkSize: defaultChunkSize,
      overlap: defaultChunkOverlap,
    });

    if (chunks.length === 0) {
      throw new Error("No extractable text found in the PDF.");
    }

    let embeddings: number[][];
    try {
      const result = await embedMany({
        model: getEmbeddingModel(),
        values: chunks.map((chunk) => chunk.content),
      });
      embeddings = result.embeddings;
    } catch (_error) {
      const result = await embedMany({
        model: getFallbackEmbeddingModel(),
        values: chunks.map((chunk) => chunk.content),
      });
      embeddings = result.embeddings;
    }

    if (embeddings.length === 0) {
      throw new Error("Failed to generate embeddings for PDF chunks.");
    }

    await ensureQdrantCollection(embeddings[0].length);

    const points = chunks.map((chunk, idx) => {
      const pointId = generateUUID();
      return {
        id: pointId,
        vector: embeddings[idx],
        payload: {
          userId,
          chatId: chatId ?? null,
          documentId,
          filename,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        },
      };
    });

    await upsertQdrantPoints(points);

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
        hypothesisId: "H3",
        location: "lib/ai/rag/indexing.ts",
        message: "Qdrant upsert completed",
        data: { chunkCount: points.length, sourceDocumentCreated },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    if (sourceDocumentCreated) {
      try {
        await saveDocumentChunks({
          chunks: points.map((point, idx) => ({
            id: generateUUID(),
            documentId,
            userId,
            chatId,
            chunkIndex: chunks[idx].chunkIndex,
            content: chunks[idx].content,
            pageStart: chunks[idx].pageStart,
            pageEnd: chunks[idx].pageEnd,
            qdrantPointId: point.id,
          })),
        });

        await updateSourceDocumentStatus({
          id: documentId,
          status: "indexed",
        });
      } catch (error) {
        console.error("Chunk metadata insert failed:", error);
      }
    }

    return { documentId, chunkCount: chunks.length };
  } catch (error) {
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
        hypothesisId: "H2",
        location: "lib/ai/rag/indexing.ts",
        message: "indexPdfDocument failed",
        data: {
          errorMessage: error instanceof Error ? error.message : "unknown",
          sourceDocumentCreated,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    if (sourceDocumentCreated) {
      await updateSourceDocumentStatus({
        id: documentId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown indexing failure",
      });
    }
    throw error;
  }
}

export async function embedQuery(query: string) {
  try {
    const { embedding } = await embed({
      model: getEmbeddingModel(),
      value: query,
    });
    return embedding;
  } catch {
    const { embedding } = await embed({
      model: getFallbackEmbeddingModel(),
      value: query,
    });
    return embedding;
  }
}
