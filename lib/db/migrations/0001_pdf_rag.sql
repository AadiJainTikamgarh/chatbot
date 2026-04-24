CREATE TABLE IF NOT EXISTS "SourceDocument" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "chatId" uuid REFERENCES "Chat"("id"),
  "filename" text NOT NULL,
  "blobUrl" text NOT NULL,
  "mimeType" varchar(128) NOT NULL,
  "status" varchar NOT NULL DEFAULT 'uploaded',
  "error" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "DocumentChunk" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "documentId" uuid NOT NULL REFERENCES "SourceDocument"("id"),
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "chatId" uuid REFERENCES "Chat"("id"),
  "chunkIndex" integer NOT NULL,
  "content" text NOT NULL,
  "pageStart" integer,
  "pageEnd" integer,
  "qdrantPointId" varchar(128) NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);
