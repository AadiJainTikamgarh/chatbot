import { geolocation, ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth } from "@/app/(auth)/auth";
import {
  allowedModelIds,
  DEFAULT_CHAT_MODEL,
  getCapabilities,
} from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import {
  retrieveAttachedPdfContext,
  retrieveRelevantPdfContext,
} from "@/lib/ai/rag/retrieval";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

function getLatestUserText(uiMessages: ChatMessage[]): string {
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const msg = uiMessages[i];
    if (msg.role !== "user") {
      continue;
    }
    const text = msg.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
    return text ?? "";
  }
  return "";
}

function getLatestUserPdfAttachments(uiMessages: ChatMessage[]) {
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const msg = uiMessages[i];
    if (msg.role !== "user") {
      continue;
    }
    const attachments = msg.parts
      ?.filter(
        (part): part is { type: "file"; mediaType: string; name: string; url: string } =>
          part.type === "file" && part.mediaType === "application/pdf"
      )
      .map((part) => ({ name: part.name, url: part.url }));
    return attachments ?? [];
  }

  return [];
}

function shouldEnableToolsForInput({
  latestUserText,
  isToolApprovalFlow,
}: {
  latestUserText: string;
  isToolApprovalFlow: boolean;
}): boolean {
  if (isToolApprovalFlow) {
    return true;
  }

  const text = latestUserText.toLowerCase().trim();
  if (!text) {
    return false;
  }

  const isGreeting = /^(hi|hello|hey|yo|hola|namaste|good (morning|afternoon|evening))([!. ,]+)?$/.test(
    text
  );

  if (isGreeting) {
    return false;
  }

  const weatherIntent =
    /\b(weather|temperature|forecast|rain|sunrise|sunset|humidity)\b/.test(
      text
    );

  const documentIntent =
    /\b(create|write|draft|generate|build|make|edit|update|rewrite|improve|refactor|fix)\b/.test(
      text
    );

  const suggestionsIntent =
    /\b(suggest|suggestions|improve this|review this document)\b/.test(text);

  return weatherIntent || documentIntent || suggestionsIntent;
}

function sanitizeMessagesForModelWithoutTools({
  messages,
  keepFiles,
}: {
  messages: ChatMessage[];
  keepFiles: boolean;
}): ChatMessage[] {
  return messages
    .map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) =>
          part.type === "text" ||
          (keepFiles &&
            part.type === "file" &&
            part.mediaType !== "application/pdf")
      ),
    }))
    .filter((message) => message.parts.length > 0);
}

function buildGroundedSystemPrompt({
  basePrompt,
  ragContext,
  hasAttachedPdf,
}: {
  basePrompt: string;
  ragContext: string;
  hasAttachedPdf: boolean;
}) {
  if (hasAttachedPdf && !ragContext) {
    return `${basePrompt}

The user attached a PDF in this turn.
Do not ask the user to paste the full PDF text.
If no reliable content is available from retrieval or file parsing, say extraction/indexing is still in progress and ask them to retry in a few seconds.`;
  }

  if (!ragContext) {
    return basePrompt;
  }

  return `${basePrompt}

Use the PDF context below as the primary source of truth for factual answers.
If the answer is not present in the provided context, say you do not have enough evidence from the uploaded PDFs.
When you use context, cite sources as: [filename (pages x-y)].

PDF Context:
${ragContext}`;
}

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const [, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chatModel = allowedModelIds.has(selectedChatModel)
      ? selectedChatModel
      : DEFAULT_CHAT_MODEL;

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsVision = capabilities?.vision === true;
    const supportsTools =
      capabilities?.tools === true &&
      shouldEnableToolsForInput({
        latestUserText: getLatestUserText(uiMessages),
        isToolApprovalFlow,
      });

    const messagesForModel = supportsTools
      ? uiMessages
      : sanitizeMessagesForModelWithoutTools({
          messages: uiMessages,
          keepFiles: supportsVision,
        });
    const latestUserText = getLatestUserText(uiMessages);
    const latestUserPdfAttachments = getLatestUserPdfAttachments(uiMessages);
    let ragContext = "";

    try {
      if (latestUserPdfAttachments.length > 0) {
        const attachedPdfContext = await retrieveAttachedPdfContext(
          latestUserPdfAttachments
        );
        ragContext = attachedPdfContext.context;
      }

      if (latestUserText) {
        const ragResult = await retrieveRelevantPdfContext({
          userId: session.user.id,
          chatId: id,
          query: latestUserText,
        });
        if (ragResult.context) {
          ragContext = ragContext
            ? `${ragContext}\n\n${ragResult.context}`
            : ragResult.context;
        }
      }
    } catch (_error) {
      // keep any attached-PDF context already collected
    }
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
        location: "app/(chat)/api/chat/route.ts",
        message: "RAG context prepared for chat response",
        data: {
          latestUserTextLength: latestUserText.length,
          attachedPdfCount: latestUserPdfAttachments.length,
          ragContextLength: ragContext.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    const modelMessages = await convertToModelMessages(messagesForModel);

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        const result = streamText({
          model: getLanguageModel(chatModel),
          system: buildGroundedSystemPrompt({
            basePrompt: systemPrompt({ requestHints, supportsTools }),
            ragContext,
            hasAttachedPdf: latestUserPdfAttachments.length > 0,
          }),
          messages: modelMessages,
          stopWhen: stepCountIs(5),
          ...(supportsTools && {
            experimental_activeTools: isReasoningModel
              ? []
              : [
                  "getWeather",
                  "createDocument",
                  "editDocument",
                  "updateDocument",
                  "requestSuggestions",
                ],
            tools: {
              getWeather,
              createDocument: createDocument({
                session,
                dataStream,
                modelId: chatModel,
              }),
              editDocument: editDocument({ dataStream, session }),
              updateDocument: updateDocument({
                session,
                dataStream,
                modelId: chatModel,
              }),
              requestSuggestions: requestSuggestions({
                session,
                dataStream,
                modelId: chatModel,
              }),
            },
          }),
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
        });

        dataStream.merge(
          result.toUIMessageStream({ sendReasoning: isReasoningModel })
        );

        if (titlePromise) {
          const title = await titlePromise;
          dataStream.write({ type: "data-chat-title", data: title });
          updateChatTitleById({ chatId: id, title });
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          for (const finishedMsg of finishedMessages) {
            const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
            if (existingMsg) {
              await updateMessage({
                id: finishedMsg.id,
                parts: finishedMsg.parts,
              });
            } else {
              await saveMessages({
                messages: [
                  {
                    id: finishedMsg.id,
                    role: finishedMsg.role,
                    parts: finishedMsg.parts,
                    createdAt: new Date(),
                    attachments: [],
                    chatId: id,
                  },
                ],
              });
            }
          }
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              id: currentMessage.id,
              role: currentMessage.role,
              parts: currentMessage.parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            })),
          });
        }
      },
      onError: (error) => {
        return "Oops, an error occurred!";
      },
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          /* non-critical */
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
