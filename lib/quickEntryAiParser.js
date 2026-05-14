const { parseQuickEntry } = require("./quickEntryParser");
const { categories, octavioLedgerCategories } = require("./quickEntryCategories");

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const fundingNatures = [...new Set(octavioLedgerCategories.map(([fundingNature]) => fundingNature))];
const ledgerCategories = [...new Set(octavioLedgerCategories.map(([, category]) => category))];
const validPairs = new Set(
  octavioLedgerCategories.map(([fundingNature, category]) => `${fundingNature}::${category}`),
);

async function parseQuickEntryWithAi(text, options = {}) {
  const geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;
  const openAiApiKey = options.apiKey || process.env.OPENAI_API_KEY;

  if (process.env.AI_PARSER_DISABLED === "true") {
    return {
      parsed: parseQuickEntry(text, options),
      parserMode: "rules",
      parserWarning: "AI parser disabled.",
    };
  }

  try {
    let parserMode = "openai";
    let aiParsed;

    if (geminiApiKey) {
      parserMode = "gemini";
      aiParsed = await requestGeminiParse(text, {
        ...options,
        apiKey: geminiApiKey,
        model: options.geminiModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      });
    } else if (openAiApiKey) {
      aiParsed = await requestOpenAiParse(text, {
        ...options,
        apiKey: openAiApiKey,
        model: options.model || process.env.OPENAI_MODEL || DEFAULT_MODEL,
      });
    } else {
      return {
        parsed: parseQuickEntry(text, options),
        parserMode: "rules",
        parserWarning: "GEMINI_API_KEY or OPENAI_API_KEY is not configured.",
      };
    }

    return {
      parsed: normalizeAiParsed(aiParsed, text, options),
      parserMode,
      parserWarning: "",
    };
  } catch (error) {
    return {
      parsed: parseQuickEntry(text, options),
      parserMode: "rules",
      parserWarning: `AI parser fallback: ${error.message}`,
    };
  }
}

async function requestGeminiParse(text, { apiKey, model, today, building, paidBy }) {
  const response = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${buildSystemPrompt({ today, building, paidBy })}\n\nEntry:\n${String(text || "")}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseJsonSchema: geminiQuickEntrySchema,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || `Gemini request failed with ${response.status}`);
  }

  const outputText = extractGeminiOutputText(payload);
  if (!outputText) {
    throw new Error("Gemini response did not include structured text output.");
  }

  return JSON.parse(outputText);
}

async function requestOpenAiParse(text, { apiKey, model, today, building, paidBy }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: buildSystemPrompt({ today, building, paidBy }),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: String(text || ""),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "farm_quick_entry_parse",
          strict: true,
          schema: quickEntrySchema,
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenAI request failed with ${response.status}`);
  }

  const outputText = extractOpenAiOutputText(payload);
  if (!outputText) {
    throw new Error("OpenAI response did not include structured text output.");
  }

  return JSON.parse(outputText);
}

function buildSystemPrompt({ today, building, paidBy }) {
  return [
    "You parse natural-language farm ledger entries written in Bisaya/Cebuano, Tagalog/Filipino, English, or code-switched mixtures.",
    "Return JSON only through the provided schema.",
    `Today is ${today || toLocalDate(new Date())}. Use it when no date is stated.`,
    `Default building is ${building || "All"}. Default paidBy is ${paidBy || "Rolly"}.`,
    "Use PHP as the currency unless the user explicitly states another currency.",
    "Map the entry to the existing Octavio Poultry Farms ledger vocabulary.",
    "For expenses: common mappings include feed/feeds/pellets/pakaon -> OPEX/Feed; charcoal/uling -> OPEX/Charcoal; tambal/gamot/medicine/vet -> OPEX/Medicine; sweldo/sahod/labor -> OPEX/Labor; kuryente/tubig/electric/water -> OPEX/Utilities; plete/hatod/delivery/fuel -> OPEX/Transport; repair/ayo/paayo/nails -> OPEX/Minor Repair; hardware/lumber/plywood/wood/cement -> CAPEX/Hardware unless it is clearly a minor repair.",
    "For income: halin/sold/baligya/sale/revenue/income -> Income and Revenue. Meat/chicken sales -> Net Meat Sale, empty sacks -> Empty Sack Sale, chicken dung/manure -> Miscellaneous Income, otherwise Miscellaneous Income.",
    "For staff cash advances: phrases like Jane cash advance 600, cash advance to Jane, advance cash Jane, or CA Jane should be type Adjustment, fundingNature Receivable, category Cash Advance, and paidTo should be the staff/person receiving the advance.",
    "For receivable payments: phrases like customer paid balance, buyer paid receivable, or bayad sa utang should be type Payment, fundingNature Receivable, category Reimbursement.",
    "Descriptions should be short title case English summaries, not full translations with extra explanation.",
    "Extract amount details into quantity, unit, unitPrice, amount, and amountSource. Use amountSource explicit when the user states a total, quantity_x_unit_price when amount is computed from quantity times unitPrice, and estimated when words like about, around, mga, murag, or siguro make the value approximate.",
    "Treat shorthand unit prices such as sold 10 trays eggs 220 each and bought 2 bags feed 1600 each as quantity_x_unit_price.",
    "If both a quantity/unit price and explicit total are present, keep quantity and unitPrice but use the explicit total as amount.",
    "Do not assign Revenue categories to Expense entries. Example: sold empty sacks 300 pesos -> Income/Revenue/Empty Sack Sale. bought sacks 300 pesos -> Expense/OPEX/Supplies.",
    "If the amount is approximate, still extract the number and lower confidence slightly.",
    "Set needs-review-like uncertainty through confidence: use lower confidence for missing amount, vague category, or ambiguous type.",
  ].join("\n");
}

const quickEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "transactionType",
    "fundingNature",
    "category",
    "quickCategory",
    "description",
    "amount",
    "quantity",
    "unit",
    "unitPrice",
    "amountSource",
    "currency",
    "paymentMethod",
    "building",
    "paidBy",
    "paidTo",
    "reference",
    "remarks",
    "date",
    "confidence",
    "originalText",
  ],
  properties: {
    type: {
      type: "string",
      enum: ["Expense", "Income", "Adjustment", "Reimbursement", "Payment"],
    },
    transactionType: {
      type: "string",
      enum: ["Expense", "Income", "Adjustment", "Reimbursement", "Payment"],
    },
    fundingNature: {
      type: "string",
      enum: fundingNatures,
    },
    category: {
      type: "string",
      enum: ledgerCategories,
    },
    quickCategory: {
      type: "string",
      enum: categories,
    },
    description: {
      type: "string",
    },
    amount: {
      anyOf: [
        { type: "number", minimum: 0 },
        { type: "null" },
      ],
    },
    quantity: {
      anyOf: [
        { type: "number", minimum: 0 },
        { type: "null" },
      ],
    },
    unit: {
      type: "string",
    },
    unitPrice: {
      anyOf: [
        { type: "number", minimum: 0 },
        { type: "null" },
      ],
    },
    amountSource: {
      anyOf: [
        {
          type: "string",
          enum: ["explicit", "quantity_x_unit_price", "estimated"],
        },
        { type: "null" },
      ],
    },
    currency: {
      type: "string",
      enum: ["PHP", "USD"],
    },
    paymentMethod: {
      type: "string",
      enum: ["Cash", "GCash", "Bank Transfer", "Card", "Other"],
    },
    building: {
      type: "string",
    },
    paidBy: {
      type: "string",
    },
    paidTo: {
      type: "string",
    },
    reference: {
      type: "string",
    },
    remarks: {
      type: "string",
    },
    date: {
      type: "string",
      format: "date",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    originalText: {
      type: "string",
    },
  },
};

const geminiQuickEntrySchema = {
  type: "object",
  required: quickEntrySchema.required,
  properties: {
    ...quickEntrySchema.properties,
    amount: {
      type: ["number", "null"],
      description: "The extracted amount. Use null only when no amount is stated.",
    },
    quantity: {
      type: ["number", "null"],
      description: "Quantity if the entry states one, otherwise null.",
    },
    unitPrice: {
      type: ["number", "null"],
      description: "Unit price if the entry states one, otherwise null.",
    },
    amountSource: {
      type: ["string", "null"],
      enum: ["explicit", "quantity_x_unit_price", "estimated", null],
      description: "Use explicit for a stated total, quantity_x_unit_price when calculated, estimated for approximate values, or null when amount is missing.",
    },
  },
};

function normalizeAiParsed(aiParsed, originalText, options = {}) {
  const fallback = parseQuickEntry(originalText, options);
  const type = normalizeType(aiParsed.type || aiParsed.transactionType || fallback.type);
  let fundingNature = aiParsed.fundingNature || fallback.fundingNature;
  let category = aiParsed.category || fallback.category;

  if (!validPairs.has(`${fundingNature}::${category}`)) {
    const pair = inferPairFromCategory(category) || [fallback.fundingNature, fallback.category];
    fundingNature = pair[0];
    category = pair[1];
  }

  if (!isTypeCompatibleWithFunding(type, fundingNature)) {
    fundingNature = fallback.fundingNature;
    category = fallback.category;
  }

  return {
    type,
    transactionType: type,
    fundingNature,
    category,
    quickCategory: categories.includes(aiParsed.quickCategory)
      ? aiParsed.quickCategory
      : fallback.quickCategory,
    description: cleanText(aiParsed.description) || fallback.description,
    amount: normalizeAmount(aiParsed.amount, fallback.amount),
    quantity: normalizeNullableNumber(aiParsed.quantity, fallback.quantity),
    unit: cleanText(aiParsed.unit) || fallback.unit || "",
    unitPrice: normalizeNullableNumber(aiParsed.unitPrice, fallback.unitPrice),
    amountSource: normalizeAmountSource(aiParsed.amountSource, fallback.amountSource),
    currency: normalizeCurrency(aiParsed.currency),
    paymentMethod: cleanText(aiParsed.paymentMethod) || "Cash",
    building: cleanText(aiParsed.building) || options.building || "All",
    paidBy: cleanText(aiParsed.paidBy) || options.paidBy || "Rolly",
    paidTo: cleanText(aiParsed.paidTo) || "",
    reference: cleanText(aiParsed.reference) || "",
    remarks: cleanText(aiParsed.remarks) || "",
    date: isDateOnly(aiParsed.date) ? aiParsed.date : fallback.date,
    confidence: normalizeConfidence(aiParsed.confidence, fallback.confidence),
    originalText: originalText.trim(),
  };
}

function extractOpenAiOutputText(payload) {
  if (payload.output_text) {
    return payload.output_text;
  }

  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("");
}

function extractGeminiOutputText(payload) {
  return (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("");
}

function normalizeType(value) {
  return ["Expense", "Income", "Adjustment", "Reimbursement", "Payment"].includes(value)
    ? value
    : "Expense";
}

function inferPairFromCategory(category) {
  return octavioLedgerCategories.find(([, currentCategory]) => currentCategory === category);
}

function isTypeCompatibleWithFunding(type, fundingNature) {
  if (type === "Income") {
    return fundingNature === "Revenue";
  }

  if (type === "Expense") {
    return fundingNature !== "Revenue";
  }

  return true;
}

function normalizeAmount(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback ?? null;
  }

  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback ?? null;
}

function normalizeNullableNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback ?? null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback ?? null;
}

function normalizeAmountSource(value, fallback) {
  return ["explicit", "quantity_x_unit_price", "estimated"].includes(value)
    ? value
    : fallback ?? null;
}

function normalizeCurrency(value) {
  const currency = String(value || "PHP").toUpperCase();
  return currency === "USD" ? "USD" : "PHP";
}

function normalizeConfidence(value, fallback) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return fallback;
  }

  return Math.max(0.01, Math.min(0.99, Number(confidence.toFixed(2))));
}

function cleanText(value) {
  return String(value || "").trim();
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function toLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  parseQuickEntryWithAi,
  normalizeAiParsed,
  quickEntrySchema,
  geminiQuickEntrySchema,
};
