import { NextResponse } from "next/server";
import { getGeminiClient, getTranscribeModel } from "@/lib/gemini";

export const runtime = "nodejs";

const MAX_AUDIO_BASE64_CHARS = 28_000_000;

function cleanTranscript(rawText: string): string {
  return rawText
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/, "")
    .replace(/^"|"$/g, "")
    .trim();
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
    const modelName = getTranscribeModel();
    const model = client.getGenerativeModel({ model: modelName });

    const result = await model.generateContent([
      {
        text: prompt,
      },
      {
        inlineData: {
          data: audioBase64,
          mimeType,
        },
      },
    ]);

    const transcript = cleanTranscript(result.response.text());

    if (!transcript) {
      return NextResponse.json(
        {
          error: "No transcript returned from Gemini.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ transcript, model: modelName });
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
