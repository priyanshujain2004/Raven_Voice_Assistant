import { NextResponse } from "next/server";
import { getGeminiClient, getTranscribeModelCandidates } from "@/lib/gemini";

export const runtime = "nodejs";

const MAX_AUDIO_BASE64_CHARS = 28_000_000;

function cleanTranscript(rawText: string): string {
  return rawText
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/, "")
    .replace(/^"|"$/g, "")
    .trim();
}

function isModelNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const status = (error as { status?: number }).status;

  return (
    status === 404 ||
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("is not found")
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      audioBase64?: unknown;
      mimeType?: unknown;
    };

    const audioBase64 =
      typeof body.audioBase64 === "string" ? body.audioBase64.trim() : "";
    const mimeType =
      typeof body.mimeType === "string" ? body.mimeType : "audio/webm";

    if (!audioBase64) {
      return NextResponse.json(
        {
          error: "audioBase64 is required",
        },
        { status: 400 },
      );
    }

    if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
      return NextResponse.json(
        {
          error: "Audio payload is too large. Keep clips under 20MB.",
        },
        { status: 413 },
      );
    }

    const prompt =
      "Transcribe this audio into plain text. Return only the transcript and no markdown.";

    const client = getGeminiClient();
    const modelCandidates = getTranscribeModelCandidates();

    let lastModelError: Error | null = null;

    for (const modelName of modelCandidates) {
      try {
        const response = await client.models.generateContent({
          model: modelName,
          contents: [
            {
              text: prompt,
            },
            {
              inlineData: {
                data: audioBase64,
                mimeType,
              },
            },
          ],
          config: {
            temperature: 0.1,
          },
        });

        const transcript = cleanTranscript((response.text ?? "").trim());

        if (!transcript) {
          continue;
        }

        return NextResponse.json({ transcript, model: modelName });
      } catch (error) {
        if (isModelNotFoundError(error)) {
          lastModelError =
            error instanceof Error
              ? error
              : new Error(`Model not found: ${modelName}`);
          continue;
        }

        throw error;
      }
    }

    if (lastModelError) {
      throw lastModelError;
    }

    return NextResponse.json(
      {
        error: "No transcript returned from Gemini for all configured models.",
      },
      { status: 502 },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while transcribing audio.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
