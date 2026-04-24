import { PDFParse } from "pdf-parse";

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
  const parser = new PDFParse({
    data: buffer,
    // pdf.js accepts this at runtime; cast keeps TypeScript happy.
    ...( { disableWorker: true } as Record<string, unknown> ),
  } as ConstructorParameters<typeof PDFParse>[0]);
  const parsed = await parser.getText();
  await parser.destroy();
  return parsed.text?.trim() ?? "";
}
