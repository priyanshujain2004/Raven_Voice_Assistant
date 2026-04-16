import { NextResponse } from "next/server";
import { getChatModel, getGeminiClient } from "@/lib/gemini";

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
    const modelName = getChatModel();
    const model = client.getGenerativeModel({ model: modelName });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.95,
        maxOutputTokens: 900,
      },
    });

    const reply = result.response.text().trim();

    if (!reply) {
      return NextResponse.json(
        { error: "Gemini returned an empty response." },
        {
          status: 502,
        },
      );
    }

    return NextResponse.json({ reply, model: modelName });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while calling Gemini.";

    return NextResponse.json(
      { error: message },
      {
        status: 500,
      },
    );
  }
}
