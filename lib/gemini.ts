import { GoogleGenAI } from "@google/genai";

let cachedGeminiClient: GoogleGenAI | null = null;

function splitModelList(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.filter(Boolean))];
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  const apiVersion = process.env.GEMINI_API_VERSION?.trim();

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  if (!cachedGeminiClient) {
    cachedGeminiClient = new GoogleGenAI({
      apiKey,
      ...(apiVersion ? { apiVersion } : {}),
    });
  }

  return cachedGeminiClient;
}

export function getChatModelCandidates(): string[] {
  const primary = process.env.GEMINI_CHAT_MODEL?.trim() || "gemini-3.1-pro";
  const fallback = splitModelList(process.env.GEMINI_CHAT_FALLBACK_MODELS);

  return uniqueModels([
    primary,
    ...fallback,
    "gemini-2.5-pro",
    "gemini-2.0-flash",
  ]);
}

export function getTranscribeModelCandidates(): string[] {
  const primary =
    process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || "gemini-3.1-pro";
  const fallback = splitModelList(
    process.env.GEMINI_TRANSCRIBE_FALLBACK_MODELS,
  );

  return uniqueModels([
    primary,
    ...fallback,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
  ]);
}
