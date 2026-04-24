import { ChatbotError } from "@/lib/errors";

type QdrantMatch = {
  documentId: string;
  filename?: string;
  chunkIndex: number;
  content: string;
  pageStart: number;
  pageEnd: number;
  score: number;
};

type QdrantPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

const qdrantUrl = process.env.QDRANT_URL;
const qdrantApiKey = process.env.QDRANT_API_KEY;
const qdrantCollection = process.env.QDRANT_COLLECTION ?? "chatbot_pdf_chunks";
const qdrantDistance = process.env.QDRANT_DISTANCE ?? "Cosine";

function getHeaders() {
  if (!qdrantUrl || !qdrantApiKey) {
    throw new ChatbotError(
      "bad_request:api",
      "Qdrant is not configured. Set QDRANT_URL and QDRANT_API_KEY."
    );
  }

  return {
    "Content-Type": "application/json",
    "api-key": qdrantApiKey,
  };
}

function getCollectionUrl(path = "") {
  if (!qdrantUrl) {
    throw new ChatbotError(
      "bad_request:api",
      "Qdrant is not configured. Set QDRANT_URL."
    );
  }
  return `${qdrantUrl}/collections/${qdrantCollection}${path}`;
}

export async function ensureQdrantCollection(vectorSize: number) {
  const headers = getHeaders();
  const url = getCollectionUrl();
  const response = await fetch(url, { headers, method: "GET" });

  if (response.ok) {
    return;
  }

  if (response.status !== 404) {
    throw new Error(`Failed to inspect Qdrant collection: ${response.status}`);
  }

  const createResponse = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: qdrantDistance,
      },
    }),
  });

  if (!createResponse.ok) {
    throw new Error(
      `Failed to create Qdrant collection: ${createResponse.status}`
    );
  }
}

export async function upsertQdrantPoints(points: QdrantPoint[]) {
  if (points.length === 0) {
    return;
  }

  const headers = getHeaders();
  const response = await fetch(getCollectionUrl("/points?wait=true"), {
    method: "PUT",
    headers,
    body: JSON.stringify({ points }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upsert Qdrant points: ${response.status}`);
  }
}

export async function queryQdrant({
  vector,
  limit,
  userId,
  chatId,
}: {
  vector: number[];
  limit: number;
  userId: string;
  chatId?: string;
}): Promise<QdrantMatch[]> {
  const must: Array<Record<string, unknown>> = [
    { key: "userId", match: { value: userId } },
  ];

  if (chatId) {
    must.push({ key: "chatId", match: { value: chatId } });
  }

  const headers = getHeaders();
  const response = await fetch(getCollectionUrl("/points/search"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter: { must },
    }),
  });

  if (!response.ok) {
    throw new Error(`Qdrant search failed: ${response.status}`);
  }

  const json = (await response.json()) as {
    result?: Array<{
      score: number;
      payload?: Record<string, unknown>;
    }>;
  };

  return (json.result ?? [])
    .map((result) => {
      const payload = result.payload ?? {};
      if (
        typeof payload.documentId !== "string" ||
        typeof payload.chunkIndex !== "number" ||
        typeof payload.content !== "string"
      ) {
        return null;
      }

      return {
        documentId: payload.documentId,
        ...(typeof payload.filename === "string"
          ? { filename: payload.filename }
          : {}),
        chunkIndex: payload.chunkIndex,
        content: payload.content,
        pageStart:
          typeof payload.pageStart === "number" ? payload.pageStart : 1,
        pageEnd: typeof payload.pageEnd === "number" ? payload.pageEnd : 1,
        score: result.score,
      };
    })
    .filter((value): value is QdrantMatch => value !== null);
}
