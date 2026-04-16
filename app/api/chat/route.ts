import { NextResponse } from "next/server";
import { parseAgentPlanText } from "@/lib/agent-actions";
import {
  formatGeminiErrorForClient,
  getChatModelCandidates,
  getGeminiClient,
  getGeminiErrorStatus,
  isModelNotFoundError,
  isQuotaOrRateLimitError,
  isServiceUnavailableError,
} from "@/lib/gemini";

export const runtime = "nodejs";

const ASSISTANT_IDENTITY =
  "You are Raven, a practical and warm personal AI voice assistant. Keep replies concise unless asked for depth. Ask one clarifying question only when needed.";

const ACTION_RULES = [
  "You can plan client-side actions for the app to execute.",
  "Return strict JSON only with keys: reply, actions.",
  "Allowed action kinds: open_url, web_search, open_map, send_email, call_phone, send_sms, copy_text, share_text, set_timer, desktop_bridge_action.",
  "For open_url provide: { kind, url } and use https URLs.",
  "For web_search provide: { kind, query }.",
  "For open_map provide: { kind, query }.",
  "For send_email provide: { kind, to?, subject?, body? }.",
  "For call_phone/send_sms provide: { kind, phoneNumber, body? }.",
  "For copy_text/share_text provide: { kind, text }.",
  "For set_timer provide: { kind, seconds, label? }.",
  "For desktop_bridge_action provide: { kind, actionId }.",
  "Only use desktop_bridge_action when user explicitly asks for desktop/PC actions.",
  "Include 0 to 4 actions only when user intent is clearly actionable.",
  "Do not include raw shell commands or destructive OS actions. Use desktop_bridge_action only with allowlisted actionId values from context.",
  'JSON output format example: {"reply":"...","actions":[{"kind":"web_search","query":"latest weather in mumbai"}]}',
].join("\n");

type NormalizedHistoryItem = {
  role: "user" | "assistant";
  text: string;
};

type DesktopBridgeContext = {
  enabled: boolean;
  actionIds: string[];
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

function normalizeDesktopBridgeContext(
  rawValue: unknown,
): DesktopBridgeContext {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return {
      enabled: false,
      actionIds: [],
    };
  }

  const rawEnabled = (rawValue as { enabled?: unknown }).enabled;
  const rawActionIds = (rawValue as { actionIds?: unknown }).actionIds;

  const actionIds = Array.isArray(rawActionIds)
    ? rawActionIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => /^[a-zA-Z0-9._-]{1,64}$/.test(value))
        .filter((value, index, allValues) => allValues.indexOf(value) === index)
        .slice(0, 40)
    : [];

  return {
    enabled: rawEnabled === true,
    actionIds,
  };
}

function buildPrompt(
  message: string,
  history: NormalizedHistoryItem[],
  desktopBridge: DesktopBridgeContext,
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

  const desktopBridgeBlock = desktopBridge.enabled
    ? desktopBridge.actionIds.length > 0
      ? `Desktop bridge is enabled on this device. If needed, only use desktop_bridge_action with one of these actionId values: ${desktopBridge.actionIds.join(", ")}.`
      : "Desktop bridge is enabled but no action IDs were provided. Do not invent actionId values. Ask the user to sync/check bridge actions first."
    : "Desktop bridge is disabled for this request. Do not include desktop_bridge_action.";

  return [
    ASSISTANT_IDENTITY,
    ACTION_RULES,
    "Conversation context:",
    historyBlock,
    "Desktop bridge context:",
    desktopBridgeBlock,
    "Latest user message:",
    message,
    "Respond as Raven and output only JSON.",
  ].join("\n\n");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      message?: unknown;
      history?: unknown;
      desktopBridge?: unknown;
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
    const desktopBridge = normalizeDesktopBridgeContext(body.desktopBridge);
    const prompt = buildPrompt(message, history, desktopBridge);

    const client = getGeminiClient();
    const modelCandidates = getChatModelCandidates();
    const apiVersion = (process.env.GEMINI_API_VERSION ?? "")
      .trim()
      .toLowerCase();

    let lastModelError: Error | null = null;

    for (const modelName of modelCandidates) {
      try {
        const generationConfig: {
          temperature: number;
          topP: number;
          maxOutputTokens: number;
          responseMimeType?: string;
        } = {
          temperature: 1,
          topP: 0.95,
          maxOutputTokens: 900,
        };

        if (apiVersion !== "v1") {
          generationConfig.responseMimeType = "application/json";
        }

        const response = await client.models.generateContent({
          model: modelName,
          contents: prompt,
          config: generationConfig,
        });

        const plan = parseAgentPlanText(response.text ?? "");
        const reply = plan.reply.trim();

        if (!reply) {
          continue;
        }

        return NextResponse.json({
          reply,
          actions: plan.actions,
          model: modelName,
        });
      } catch (error) {
        if (
          isModelNotFoundError(error) ||
          isQuotaOrRateLimitError(error) ||
          isServiceUnavailableError(error)
        ) {
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
