import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { titleModel } from "./models";

export const myProvider = isTestEnvironment
  ? (() => {
      const { chatModel, titleModel } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "title-model": titleModel,
        },
      });
    })()
  : null;

const gemini = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  return gemini.chat(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gemini.chat(titleModel.id);
}

export function getEmbeddingModel() {
  const modelId = process.env.GEMINI_EMBEDDING_MODEL ?? "embedding-001";
  return gemini.textEmbeddingModel(modelId);
}

export function getFallbackEmbeddingModel() {
  return gemini.textEmbeddingModel("embedding-001");
}
