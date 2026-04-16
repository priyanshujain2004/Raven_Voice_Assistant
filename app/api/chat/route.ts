import { NextResponse } from "next/server";
import {
  formatGeminiErrorForClient,
  getChatModelCandidates,
  getGeminiClient,
  getGeminiErrorStatus,
  isModelNotFoundError,
  isQuotaOrRateLimitError,
} from "@/lib/gemini";

export const runtime = "nodejs";

const ASSISTANT_IDENTITY =
  "You are Raven, a practical and warm personal AI voice assistant. Keep replies concise unless asked for depth. Ask one clarifying question only when needed.";

type NormalizedHistoryItem = {
  role: "user" | "assistant";
  text: string;
};

function normalizeHistory(rawHistory: unknown): NormalizedHistoryItem[] {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  return rawHistory
    .map((item): NormalizedHistoryItem | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const role = (item as { role?: unknown }).role;
      const text = (item as { text?: unknown }).text;

      if (
        (role !== "user" && role !== "assistant") ||
        typeof text !== "string"
      ) {
        return null;
      }

      const trimmedText = text.trim();
      if (!trimmedText) {
        return null;
      }

      return {
        role,
        text: trimmedText,
      };
    })
    .filter((item): item is NormalizedHistoryItem => Boolean(item))
    .slice(-12);
}

function buildPrompt(
  message: string,
  history: NormalizedHistoryItem[],
): string {
  const historyBlock =
    history.length > 0
      ? history
          .map(
            (item, index) =>
              `${index + 1}. ${item.role === "user" ? "User" : "Assistant"}: ${item.text}`,
          )
          .join("\n")
      : "(no prior context)";

  return [
    ASSISTANT_IDENTITY,
    "Conversation context:",
    historyBlock,
    "Latest user message:",
    message,
    "Respond as Raven.",
  ].join("\n\n");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      message?: unknown;
      history?: unknown;
    };

    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      return NextResponse.json(
        { error: "message is required" },
        {
          status: 400,
        },
      );
    }

    const history = normalizeHistory(body.history);
    const prompt = buildPrompt(message, history);

    const client = getGeminiClient();
    const modelCandidates = getChatModelCandidates();

    let lastModelError: Error | null = null;

    for (const modelName of modelCandidates) {
      try {
        const response = await client.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            temperature: 1,
            topP: 0.95,
            maxOutputTokens: 900,
          },
        });

        const reply = (response.text ?? "").trim();

        if (!reply) {
          continue;
        }

        return NextResponse.json({ reply, model: modelName });
      } catch (error) {
        if (isModelNotFoundError(error) || isQuotaOrRateLimitError(error)) {
          lastModelError =
            error instanceof Error
              ? error
              : new Error(`Model unavailable: ${modelName}`);
          continue;
        }

        throw error;
      }
    }

    if (lastModelError) {
      throw lastModelError;
    }

    return NextResponse.json(
      { error: "Gemini returned an empty response for all configured models." },
      {
        status: 502,
      },
    );
  } catch (error) {
    const status = getGeminiErrorStatus(error);
    const message = formatGeminiErrorForClient(error);

    return NextResponse.json(
      { error: message },
      {
        status,
      },
    );
  }
}
