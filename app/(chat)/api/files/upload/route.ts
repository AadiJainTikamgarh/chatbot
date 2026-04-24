import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { indexPdfDocument } from "@/lib/ai/rag/indexing";

const acceptedTypes = ["image/jpeg", "image/png", "application/pdf"];

async function uploadToCloudinary({
  fileBuffer,
  fileName,
  mimeType,
}: {
  fileBuffer: ArrayBuffer;
  fileName: string;
  mimeType: string;
}) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_UPLOAD_FOLDER ?? "chatbot";

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary env is missing.");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${Date.now()}-${fileName.replace(/\.[^/.]+$/, "")}`;
  const resourceType = mimeType === "application/pdf" ? "raw" : "image";
  const uploadType = "upload";
  const accessMode = "public";
  const signatureBase =
    `access_mode=${accessMode}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}&type=${uploadType}${apiSecret}`;
  const signature = createHash("sha1").update(signatureBase).digest("hex");

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append("api_key", apiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("folder", folder);
  formData.append("public_id", publicId);
  formData.append("access_mode", accessMode);
  formData.append("type", uploadType);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
    {
      method: "POST",
      body: formData,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudinary upload failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as {
    secure_url: string;
    public_id: string;
    original_filename?: string;
    format?: string;
    bytes?: number;
    resource_type?: string;
  };

  return json;
}

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 20 * 1024 * 1024, {
      message: "File size should be less than 20MB",
    })
    .refine((file) => acceptedTypes.includes(file.type), {
      message: "File type should be JPEG, PNG, or PDF",
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;
    const chatId = String(formData.get("chatId") ?? "").trim() || undefined;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const filename = (formData.get("file") as File).name;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileBuffer = await file.arrayBuffer();

    try {
      const cloudinaryData = await uploadToCloudinary({
        fileBuffer,
        fileName: safeName,
        mimeType: file.type,
      });
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
          hypothesisId: "H1",
          location: "app/(chat)/api/files/upload/route.ts",
          message: "Cloudinary upload completed",
          data: {
            contentType: file.type,
            secureUrl: cloudinaryData.secure_url,
            resourceType: cloudinaryData.resource_type ?? null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      const pathname = cloudinaryData.format
        ? `${cloudinaryData.original_filename ?? safeName}.${cloudinaryData.format}`
        : cloudinaryData.original_filename ?? safeName;

      if (file.type === "application/pdf") {
        const indexingPayload = {
          userId: session.user.id,
          chatId: undefined,
          filename: safeName,
          blobUrl: cloudinaryData.secure_url,
          mimeType: file.type,
          pdfBuffer: fileBuffer,
        };

        // Parse/index directly from uploaded bytes to avoid Cloudinary delivery issues.
        void indexPdfDocument(indexingPayload).catch((error) => {
          console.error("PDF indexing failed:", error);
        });
      }

      return NextResponse.json({
        url: cloudinaryData.secure_url,
        pathname,
        contentType: file.type,
        publicId: cloudinaryData.public_id,
      });
    } catch (_error) {
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
