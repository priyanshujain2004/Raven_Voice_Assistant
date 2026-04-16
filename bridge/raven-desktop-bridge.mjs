import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const DEFAULT_CONFIG_PATH = "bridge/bridge.config.json";
const DEFAULT_ALLOWLIST_PATH = "bridge/allowlist.json";
const MAX_REQUEST_BYTES = 16_384;
const ACTION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

function failStartup(message) {
  console.error(`[raven-bridge] ${message}`);
  process.exit(1);
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => asTrimmedString(entry)).filter(Boolean);
}

function readJsonFile(filePath) {
  const content = readFileSync(filePath, "utf8");

  try {
    return JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failStartup(`Invalid JSON in ${filePath}: ${reason}`);
  }
}

function normalizeOrigins(rawOrigins) {
  return new Set(
    asStringArray(rawOrigins).map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        failStartup(`Invalid allowed origin: ${origin}`);
      }
    }),
  );
}

function loadBridgeConfig() {
  const configuredPath = asTrimmedString(process.env.RAVEN_BRIDGE_CONFIG);
  const configPath = resolve(
    process.cwd(),
    configuredPath || DEFAULT_CONFIG_PATH,
  );

  if (!existsSync(configPath)) {
    failStartup(
      `Bridge config not found at ${configPath}. Create bridge/bridge.config.json first.`,
    );
  }

  const rawConfig = readJsonFile(configPath);

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    failStartup(`Bridge config must be a JSON object: ${configPath}`);
  }

  const host = asTrimmedString(rawConfig.host) || "127.0.0.1";
  const port = Number(rawConfig.port ?? 4789);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failStartup("Bridge port must be an integer between 1 and 65535.");
  }

  const token =
    asTrimmedString(process.env.RAVEN_BRIDGE_TOKEN) ||
    asTrimmedString(rawConfig.token);

  if (!token) {
    failStartup(
      "Missing bridge token. Set token in bridge.config.json or RAVEN_BRIDGE_TOKEN.",
    );
  }

  if (token.length < 16) {
    failStartup("Bridge token must be at least 16 characters for security.");
  }

  if (token === "replace-with-a-long-random-token") {
    failStartup(
      "Replace the default bridge token in bridge/bridge.config.json before starting the bridge.",
    );
  }

  const allowlistPathInput =
    asTrimmedString(process.env.RAVEN_BRIDGE_ALLOWLIST) ||
    asTrimmedString(rawConfig.allowlistPath) ||
    DEFAULT_ALLOWLIST_PATH;

  const allowlistPath = resolve(process.cwd(), allowlistPathInput);

  if (!existsSync(allowlistPath)) {
    failStartup(`Allowlist not found at ${allowlistPath}.`);
  }

  const envOrigins = asTrimmedString(process.env.RAVEN_BRIDGE_ALLOWED_ORIGINS);
  const rawOrigins = envOrigins
    ? envOrigins.split(",")
    : Array.isArray(rawConfig.allowedOrigins)
      ? rawConfig.allowedOrigins
      : [];

  const allowedOrigins = normalizeOrigins(rawOrigins);

  if (allowedOrigins.size === 0) {
    failStartup(
      "No allowedOrigins configured. Add your app origins to bridge.config.json.",
    );
  }

  return {
    configPath,
    host,
    port,
    token,
    allowlistPath,
    allowedOrigins,
  };
}

function loadAllowlist(allowlistPath) {
  const rawAllowlist = readJsonFile(allowlistPath);

  if (
    !rawAllowlist ||
    typeof rawAllowlist !== "object" ||
    Array.isArray(rawAllowlist)
  ) {
    failStartup(`Allowlist must be a JSON object: ${allowlistPath}`);
  }

  const rawActions = Array.isArray(rawAllowlist.actions)
    ? rawAllowlist.actions
    : [];

  const actions = new Map();

  for (const rawAction of rawActions) {
    if (
      !rawAction ||
      typeof rawAction !== "object" ||
      Array.isArray(rawAction)
    ) {
      continue;
    }

    const id = asTrimmedString(rawAction.id);
    const type = asTrimmedString(rawAction.type) || "spawn";
    const command = asTrimmedString(rawAction.command);
    const args = asStringArray(rawAction.args);
    const cwd = asTrimmedString(rawAction.cwd);
    const windowsHide = rawAction.windowsHide !== false;

    if (!id || !ACTION_ID_PATTERN.test(id)) {
      failStartup(
        `Invalid action id \"${id}\". Use 1-64 chars: letters, numbers, dot, underscore, hyphen.`,
      );
    }

    if (type !== "spawn") {
      failStartup(
        `Unsupported action type for ${id}: ${type}. Only \"spawn\" is supported.`,
      );
    }

    if (!command) {
      failStartup(`Action ${id} is missing command.`);
    }

    actions.set(id, {
      id,
      type,
      command,
      args,
      cwd: cwd ? resolve(process.cwd(), cwd) : undefined,
      windowsHide,
    });
  }

  if (actions.size === 0) {
    failStartup(`No valid actions found in allowlist: ${allowlistPath}`);
  }

  return actions;
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function applyCors(request, response, allowedOrigins) {
  const origin = asTrimmedString(request.headers.origin);

  response.setHeader("Vary", "Origin");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-raven-bridge-token",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (!origin) {
    return true;
  }

  let normalizedOrigin = "";

  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  if (!allowedOrigins.has(normalizedOrigin)) {
    return false;
  }

  response.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
  return true;
}

function isAuthorized(request, expectedToken) {
  const providedToken = asTrimmedString(
    request.headers["x-raven-bridge-token"],
  );

  if (!providedToken) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(providedToken);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;

    request.on("data", (chunk) => {
      total += chunk.length;

      if (total > MAX_REQUEST_BYTES) {
        rejectBody(new Error("Payload too large."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", (error) => {
      rejectBody(error);
    });
  });
}

function executeAllowlistedAction(action) {
  const child = spawn(action.command, action.args, {
    cwd: action.cwd,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: action.windowsHide,
  });

  child.unref();
}

const config = loadBridgeConfig();
const actions = loadAllowlist(config.allowlistPath);

console.log(`[raven-bridge] Config: ${config.configPath}`);
console.log(
  `[raven-bridge] Allowlist: ${config.allowlistPath} (${actions.size} actions)`,
);
console.log(
  `[raven-bridge] Allowed origins: ${Array.from(config.allowedOrigins).join(", ")}`,
);

const server = createServer(async (request, response) => {
  const corsAllowed = applyCors(request, response, config.allowedOrigins);

  if (!corsAllowed) {
    sendJson(response, 403, {
      error: "Origin is not allowed by bridge CORS policy.",
    });
    return;
  }

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || `${config.host}:${config.port}`}`,
  );

  if (!isAuthorized(request, config.token)) {
    sendJson(response, 401, { error: "Invalid bridge token." });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      bridge: "raven-desktop-bridge",
      actionCount: actions.size,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/actions") {
    sendJson(response, 200, {
      actions: Array.from(actions.keys()),
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/execute") {
    let rawBody = "";

    try {
      rawBody = await readRequestBody(request);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Request read failed.";
      sendJson(response, 413, { error: reason });
      return;
    }

    let payload = null;

    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }

    const actionId = asTrimmedString(payload?.actionId);

    if (!actionId || !ACTION_ID_PATTERN.test(actionId)) {
      sendJson(response, 400, { error: "actionId is invalid." });
      return;
    }

    const action = actions.get(actionId);

    if (!action) {
      sendJson(response, 404, {
        error: `Action \"${actionId}\" is not allowlisted on this device.`,
      });
      return;
    }

    try {
      executeAllowlistedAction(action);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Execution failed.";
      sendJson(response, 500, { error: reason });
      return;
    }

    console.log(`[raven-bridge] Executed action: ${actionId}`);

    sendJson(response, 200, {
      ok: true,
      actionId,
      message: `Executed desktop action: ${actionId}`,
    });
    return;
  }

  sendJson(response, 404, { error: "Route not found." });
});

server.listen(config.port, config.host, () => {
  console.log(
    `[raven-bridge] Listening on http://${config.host}:${config.port}`,
  );
});
