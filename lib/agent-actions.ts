export type AgentAction =
  | {
      kind: "open_url";
      url: string;
      title?: string;
      newTab?: boolean;
    }
  | {
      kind: "web_search";
      query: string;
      title?: string;
    }
  | {
      kind: "open_map";
      query: string;
      title?: string;
    }
  | {
      kind: "send_email";
      to?: string;
      subject?: string;
      body?: string;
      title?: string;
    }
  | {
      kind: "call_phone";
      phoneNumber: string;
      title?: string;
    }
  | {
      kind: "send_sms";
      phoneNumber: string;
      body?: string;
      title?: string;
    }
  | {
      kind: "copy_text";
      text: string;
      title?: string;
    }
  | {
      kind: "share_text";
      text: string;
      title?: string;
    }
  | {
      kind: "set_timer";
      seconds: number;
      label?: string;
      title?: string;
    };

export interface AgentPlan {
  reply: string;
  actions: AgentAction[];
}

const MAX_ACTIONS = 4;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(urlValue: unknown): string | null {
  const rawUrl = asTrimmedString(urlValue);
  if (!rawUrl) {
    return null;
  }

  const candidate = rawUrl.startsWith("www.") ? `https://${rawUrl}` : rawUrl;

  if (/^(javascript|data|file):/i.test(candidate)) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizePhoneNumber(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) {
    return null;
  }

  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned || cleaned.length < 6) {
    return null;
  }

  return cleaned;
}

function normalizeTimerSeconds(value: unknown): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Math.min(Math.max(Math.round(numericValue), 3), 86_400);
}

function normalizeActionKind(rawKind: string): AgentAction["kind"] | "" {
  const kind = rawKind.toLowerCase();
  const map: Record<string, AgentAction["kind"]> = {
    open_url: "open_url",
    open_link: "open_url",
    web_search: "web_search",
    search_web: "web_search",
    open_map: "open_map",
    maps: "open_map",
    send_email: "send_email",
    email: "send_email",
    call_phone: "call_phone",
    call: "call_phone",
    send_sms: "send_sms",
    sms: "send_sms",
    copy_text: "copy_text",
    copy: "copy_text",
    share_text: "share_text",
    share: "share_text",
    set_timer: "set_timer",
    timer: "set_timer",
  };

  return map[kind] || "";
}

function normalizeAction(value: unknown): AgentAction | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const normalizedKind = normalizeActionKind(asTrimmedString(record.kind));
  const title = asTrimmedString(record.title) || undefined;

  switch (normalizedKind) {
    case "open_url": {
      const url = normalizeUrl(record.url);
      if (!url) {
        return null;
      }

      return {
        kind: "open_url",
        url,
        title,
        newTab: record.newTab !== false,
      };
    }
    case "web_search": {
      const query = asTrimmedString(record.query);
      if (!query) {
        return null;
      }

      return {
        kind: "web_search",
        query,
        title,
      };
    }
    case "open_map": {
      const query = asTrimmedString(record.query);
      if (!query) {
        return null;
      }

      return {
        kind: "open_map",
        query,
        title,
      };
    }
    case "send_email": {
      const to = asTrimmedString(record.to) || undefined;
      const subject = asTrimmedString(record.subject) || undefined;
      const body = asTrimmedString(record.body) || undefined;

      if (!to && !subject && !body) {
        return null;
      }

      return {
        kind: "send_email",
        to,
        subject,
        body,
        title,
      };
    }
    case "call_phone": {
      const phoneNumber = normalizePhoneNumber(record.phoneNumber);
      if (!phoneNumber) {
        return null;
      }

      return {
        kind: "call_phone",
        phoneNumber,
        title,
      };
    }
    case "send_sms": {
      const phoneNumber = normalizePhoneNumber(record.phoneNumber);
      const body = asTrimmedString(record.body) || undefined;
      if (!phoneNumber) {
        return null;
      }

      return {
        kind: "send_sms",
        phoneNumber,
        body,
        title,
      };
    }
    case "copy_text": {
      const text = asTrimmedString(record.text);
      if (!text) {
        return null;
      }

      return {
        kind: "copy_text",
        text,
        title,
      };
    }
    case "share_text": {
      const text = asTrimmedString(record.text);
      if (!text) {
        return null;
      }

      return {
        kind: "share_text",
        text,
        title,
      };
    }
    case "set_timer": {
      const seconds = normalizeTimerSeconds(
        record.seconds ?? record.durationSeconds,
      );
      if (!seconds) {
        return null;
      }

      return {
        kind: "set_timer",
        seconds,
        label: asTrimmedString(record.label) || undefined,
        title,
      };
    }
    default:
      return null;
  }
}

export function normalizeAgentPlan(rawValue: unknown): AgentPlan {
  const record = asRecord(rawValue);

  const rawReply = record ? asTrimmedString(record.reply) : "";
  const rawActions =
    record && Array.isArray(record.actions) ? record.actions : [];

  const actions = rawActions
    .map((action) => normalizeAction(action))
    .filter((action): action is AgentAction => Boolean(action))
    .slice(0, MAX_ACTIONS);

  return {
    reply: rawReply || "I can help with that.",
    actions,
  };
}

function tryParseJson(rawText: string): unknown | null {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

export function parseAgentPlanText(rawText: string): AgentPlan {
  const fenced = rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const direct = tryParseJson(fenced);
  if (direct) {
    return normalizeAgentPlan(direct);
  }

  const firstBrace = fenced.indexOf("{");
  const lastBrace = fenced.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const fragment = fenced.slice(firstBrace, lastBrace + 1);
    const parsedFragment = tryParseJson(fragment);
    if (parsedFragment) {
      return normalizeAgentPlan(parsedFragment);
    }
  }

  return normalizeAgentPlan({
    reply: fenced,
    actions: [],
  });
}

export function describeAgentAction(action: AgentAction): string {
  if (action.title) {
    return action.title;
  }

  switch (action.kind) {
    case "open_url":
      return `Open ${action.url}`;
    case "web_search":
      return `Search web: ${action.query}`;
    case "open_map":
      return `Open map for: ${action.query}`;
    case "send_email":
      return "Draft an email";
    case "call_phone":
      return `Call ${action.phoneNumber}`;
    case "send_sms":
      return `Text ${action.phoneNumber}`;
    case "copy_text":
      return "Copy text to clipboard";
    case "share_text":
      return "Share text";
    case "set_timer":
      return `Set timer for ${action.seconds}s`;
    default:
      return "Run action";
  }
}

export function actionNeedsConfirmation(action: AgentAction): boolean {
  switch (action.kind) {
    case "web_search":
    case "open_map":
    case "copy_text":
    case "share_text":
    case "set_timer":
      return false;
    default:
      return true;
  }
}
