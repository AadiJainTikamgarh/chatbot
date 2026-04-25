import { createRequire } from "node:module";

type PDFParseInstance = {
  getText(): Promise<{ text?: string }>;
  destroy(): Promise<void> | void;
};

type PDFParseOptions = {
  data: Buffer;
  disableWorker?: boolean;
  [key: string]: unknown;
};

type PDFParseModule = {
  PDFParse: new (options: PDFParseOptions) => PDFParseInstance;
};

let pdfParseModulePromise: Promise<PDFParseModule> | null = null;
const nodeRequire = createRequire(import.meta.url);

async function loadPdfParseModule() {
  if (!pdfParseModulePromise) {
    pdfParseModulePromise = Promise.resolve(
      nodeRequire("pdf-parse") as PDFParseModule
    );
  }

  return pdfParseModulePromise;
}

function getCloudinaryPdfFallbackUrls(url: string): string[] {
  if (!url.includes("res.cloudinary.com") || !url.includes("/image/upload/")) {
    return [];
  }

  const baseRawUrl = url.replace("/image/upload/", "/raw/upload/");
  const candidates = new Set<string>([baseRawUrl]);

  // If extension is missing in transformed URL, add .pdf variant.
  if (!baseRawUrl.toLowerCase().endsWith(".pdf")) {
    candidates.add(`${baseRawUrl}.pdf`);
  }

  return [...candidates];
}

export async function extractPdfTextFromUrl(url: string): Promise<string> {
  const candidateUrls = [url, ...getCloudinaryPdfFallbackUrls(url)];
  let response: Response | null = null;
  let lastStatus: number | null = null;

  for (const candidateUrl of candidateUrls) {
    const candidateResponse = await fetch(candidateUrl);
    if (candidateResponse.ok) {
      response = candidateResponse;
      break;
    }
    lastStatus = candidateResponse.status;
  }

  if (!response) {
    throw new Error(`Failed to download PDF: ${lastStatus ?? "unknown"}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return extractPdfTextFromBuffer(arrayBuffer);
}

export async function extractPdfTextFromBuffer(
  pdfBuffer: ArrayBuffer | Buffer
): Promise<string> {
  const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const { PDFParse } = await loadPdfParseModule();
  const parser = new PDFParse({ data: buffer, disableWorker: true });
  const parsed = await parser.getText();
  await parser.destroy();
  return parsed.text?.trim() ?? "";
}
