const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

async function createFlockOpsReply({
  message,
  context = {},
  user = {},
  permissions = {},
  chatHistory = [],
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
}) {
  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) {
    const error = new Error("Message is required.");
    error.statusCode = 400;
    throw error;
  }

  const systemPrompt = buildFlockOpsSystemPrompt({
    context: sanitizeContext(context, permissions),
    user,
    permissions,
  });

  const contents = [];
  if (Array.isArray(chatHistory)) {
    chatHistory.forEach((turn) => {
      const role = turn.role === "assistant" || turn.sender === "assistant" || turn.role === "model" ? "model" : "user";
      const text = turn.text || turn.message || turn.content || "";
      if (text) {
        contents.push({
          role,
          parts: [{ text }],
        });
      }
    });
  }

  contents.push({
    role: "user",
    parts: [{ text: normalizedMessage }],
  });

  const response = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents,
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 420,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error?.message || `Gemini request failed with ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const reply = extractGeminiOutputText(payload).trim();
  if (!reply) {
    throw new Error("Gemini response did not include text output.");
  }

  return {
    reply,
    model,
    provider: "gemini",
  };
}

function buildFlockOpsSystemPrompt({ context, user, permissions }) {
  return [
    "You are FlockOps Assistant for Octavio Poultry Farms.",
    "Answer as a practical poultry farm operations assistant with a warm, grounded tone.",
    "Use short paragraphs or bullets. Keep replies under 140 words unless the user asks for detail.",
    "Do not call the user Captain. Avoid sci-fi branding. Zero-G is only a small UI mode.",
    "Never suggest opening screens, actions, or finance flows that are not allowed by permissions.",
    "If the user asks for data that is missing from context, say what is missing and suggest the closest allowed screen.",
    "Do not invent farm numbers. Use only the context below.",
    "",
    "Permissions:",
    JSON.stringify({
      role: user.role || "Unknown",
      canEnterDaily: Boolean(permissions.canEnterDaily),
      canViewFinancial: Boolean(permissions.canViewFinancial),
      canManageOperations: Boolean(permissions.canManageOperations),
      allowedScreens: permissions.allowedScreens || [],
    }),
    "",
    "Current farm context:",
    JSON.stringify(context),
  ].join("\n");
}

function sanitizeContext(context, permissions) {
  const safeContext = {
    isZeroGravity: Boolean(context.isZeroGravity),
    availableFlows: toStringArray(context.availableFlows).slice(0, 12),
    activeBatch: sanitizeActiveBatch(context.activeBatch),
    metrics: pick(context.metrics, [
      "loaded",
      "totalMortality",
      "liveBirds",
      "mortalityPercent",
      "totalFeedBags",
      "totalFeedKg",
      "todayLogCount",
      "todayMortality",
      "todayFeedBags",
      "latestWeight",
      "latestWeightDate",
      "fcr",
      "age",
      "daysToHarvest",
    ]),
    recentLogs: toObjectArray(context.recentLogs).slice(0, 6).map((log) => pick(log, [
      "date",
      "building",
      "mortality",
      "feed",
      "averageWeightGrams",
      "remarks",
    ])),
  };

  if (permissions.canViewFinancial) {
    safeContext.financials = pick(context.financials, ["income", "expenses", "net", "transactionCount"]);
  }

  return safeContext;
}

function sanitizeActiveBatch(activeBatch) {
  const safeBatch = pick(activeBatch, [
    "id",
    "batchCode",
    "startDate",
    "targetHarvestDate",
    "status",
    "plannedFlock",
    "targetFeedKg",
  ]);

  if (!safeBatch || !activeBatch || typeof activeBatch !== "object") return safeBatch;

  const hasConfirmedArrival = activeBatch.hasConfirmedArrival === true;
  safeBatch.hasConfirmedArrival = hasConfirmedArrival;

  if (hasConfirmedArrival) {
    Object.assign(safeBatch, pick(activeBatch, [
      "totalChicksLoaded",
      "actualChicksArrived",
      "doaCount",
      "netChicksPlaced",
    ]));
  }

  return safeBatch;
}

function pick(source, keys) {
  if (!source || typeof source !== "object") return null;
  return keys.reduce((result, key) => {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      result[key] = source[key];
    }
    return result;
  }, {});
}

function toStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function toObjectArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function extractGeminiOutputText(payload) {
  return payload.candidates
    ?.flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    || "";
}

module.exports = {
  createFlockOpsReply,
};
