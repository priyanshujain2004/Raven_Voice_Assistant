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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "");
}

function getRetryDelayHintSeconds(errorMessage: string): number | null {
  const retryInMatch = errorMessage.match(/retry in\s+([\d.]+)s/i);
  if (retryInMatch) {
    const parsedSeconds = Number(retryInMatch[1]);
    if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
      return Math.ceil(parsedSeconds);
    }
  }

  const retryDelayMatch = errorMessage.match(/"retryDelay":"([\d.]+)s"/i);
  if (retryDelayMatch) {
    const parsedSeconds = Number(retryDelayMatch[1]);
    if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
      return Math.ceil(parsedSeconds);
    }
  }

  return null;
}

function formatRetryDelay(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
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
  const primary = process.env.GEMINI_CHAT_MODEL?.trim() || "gemini-2.5-flash";
  const fallback = splitModelList(process.env.GEMINI_CHAT_FALLBACK_MODELS);

  return uniqueModels([
    primary,
    ...fallback,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
  ]);
}

export function getTranscribeModelCandidates(): string[] {
  const primary =
    process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || "gemini-2.5-flash";
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

export function isModelNotFoundError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const status = (error as { status?: number })?.status;

  return (
    status === 404 ||
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("is not found")
  );
}

export function isQuotaOrRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const status = (error as { status?: number })?.status;

  return (
    status === 429 ||
    message.includes("429") ||
    message.includes("resource_exhausted") ||
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  );
}

export function isServiceUnavailableError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const status = (error as { status?: number })?.status;

  return (
    status === 503 ||
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("currently experiencing high demand") ||
    message.includes('"status":"unavailable"')
  );
}

export function getGeminiErrorStatus(error: unknown): number {
  const status = (error as { status?: number })?.status;
  if (typeof status === "number") {
    return status;
  }

  const message = getErrorMessage(error);
  const codeMatch = message.match(/"code"\s*:\s*(\d{3})/);
  if (codeMatch) {
    return Number(codeMatch[1]);
  }

  if (isQuotaOrRateLimitError(error)) {
    return 429;
  }

  if (isServiceUnavailableError(error)) {
    return 503;
  }

  if (isModelNotFoundError(error)) {
    return 404;
  }

  return 500;
}

export function formatGeminiErrorForClient(error: unknown): string {
  const message = getErrorMessage(error);

  if (isQuotaOrRateLimitError(error)) {
    const retrySeconds = getRetryDelayHintSeconds(message);
    const retryText = retrySeconds
      ? ` Try again in about ${formatRetryDelay(retrySeconds)}.`
      : "";

    return `Gemini quota or rate limit reached for current models.${retryText} Raven can use Flash fallbacks; if this keeps happening, enable billing or switch to lower-cost models in your env settings.`;
  }

  if (isModelNotFoundError(error)) {
    return "Configured Gemini model is not available for your key/API version. Use a supported model or update API version.";
  }

  if (isServiceUnavailableError(error)) {
    return "Gemini is under high demand right now for the selected models. Raven already tried fallback models. Please retry in about 30 to 90 seconds.";
  }

  if (message.length > 420) {
    return "Gemini request failed. Check server logs for full details.";
  }

  return message || "Unexpected Gemini error.";
}
