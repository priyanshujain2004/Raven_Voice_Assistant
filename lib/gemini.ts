import { GoogleGenerativeAI } from "@google/generative-ai";

let cachedGeminiClient: GoogleGenerativeAI | null = null;

export function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  if (!cachedGeminiClient) {
    cachedGeminiClient = new GoogleGenerativeAI(apiKey);
  }

  return cachedGeminiClient;
}

export function getChatModel(): string {
  return process.env.GEMINI_CHAT_MODEL || "gemini-3.1-pro";
}

export function getTranscribeModel(): string {
  return process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.1-pro";
}
