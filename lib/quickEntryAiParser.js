const { parseQuickEntry } = require("./quickEntryParser");
const { categories, octavioLedgerCategories } = require("./quickEntryCategories");

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
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
  const geminiModel = options.geminiModel || process.env.GEMINI_PARSER_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const openAiModel = options.model || process.env.OPENAI_MODEL || DEFAULT_MODEL;

  if (process.env.AI_PARSER_DISABLED === "true") {
    return {
      parsed: parseQuickEntry(text, options),
      parserMode: "rules",
      parserModel: "rules",
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
        model: geminiModel,
      });
    } else if (openAiApiKey) {
      aiParsed = await requestOpenAiParse(text, {
        ...options,
        apiKey: openAiApiKey,
        model: openAiModel,
      });
    } else {
      return {
        parsed: parseQuickEntry(text, options),
        parserMode: "rules",
        parserModel: "rules",
        parserWarning: "GEMINI_API_KEY or OPENAI_API_KEY is not configured.",
      };
    }

    return {
      parsed: normalizeAiParsed(aiParsed, text, options),
      parserMode,
      parserModel: parserMode === "gemini" ? geminiModel : openAiModel,
      parserWarning: "",
    };
  } catch (error) {
    return {
      parsed: parseQuickEntry(text, options),
      parserMode: "rules",
      parserModel: "rules",
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

function getRelativeDateInfo(todayStr) {
  let baseDate = new Date();
  if (todayStr) {
    const parts = todayStr.split("-");
    if (parts.length === 3) {
      baseDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
  }

  const addDays = (d, days) => {
    const newDate = new Date(d);
    newDate.setDate(newDate.getDate() + days);
    return newDate;
  };

  const yesterday = addDays(baseDate, -1);
  const twoDaysAgo = addDays(baseDate, -2);
  const threeDaysAgo = addDays(baseDate, -3);

  const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const daysOfWeekCebuano = ["Domingo", "Lunes", "Martes", "Miyerkules", "Huwebes", "Biyernes", "Sabado"];
  const daysOfWeekTagalog = ["Linggo", "Lunes", "Martes", "Miyerkules", "Huwebes", "Biyernes", "Sabado"];
  
  const weeklyReferences = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(baseDate, -i);
    const dayName = daysOfWeek[d.getDay()];
    const dayNameCeb = daysOfWeekCebuano[d.getDay()];
    const dayNameTag = daysOfWeekTagalog[d.getDay()];
    const formatted = toLocalDate(d);
    weeklyReferences.push(`- Last ${dayName} / ${dayNameCeb} / ${dayNameTag}: ${formatted}`);
  }

  return {
    today: toLocalDate(baseDate),
    yesterday: toLocalDate(yesterday),
    twoDaysAgo: toLocalDate(twoDaysAgo),
    threeDaysAgo: toLocalDate(threeDaysAgo),
    weeklyReferences: weeklyReferences.join("\n"),
  };
}

function buildSystemPrompt({ today, building, paidBy }) {
  const dateInfo = getRelativeDateInfo(today || toLocalDate(new Date()));

  // Format valid [fundingNature, category] pairs
  const validPairsList = octavioLedgerCategories
    .map(([fn, cat]) => `- [${fn}, ${cat}]`)
    .join("\n");

  return [
    "You are an expert AI data entry assistant for Octavio Poultry Farms ledger.",
    "Your task is to parse natural-language farm ledger entries written in Bisaya/Cebuano, Tagalog/Filipino, English, or mixtures (code-switching).",
    "Return JSON only conforming strictly to the provided schema.",
    "",
    "=== DATE REFERENCE ===",
    `Reference Date (Today): ${dateInfo.today}`,
    `Yesterday (gahapon / kahapon): ${dateInfo.yesterday}`,
    `2 days ago (adlaw nga miagi / kamakailan): ${dateInfo.twoDaysAgo}`,
    `3 days ago: ${dateInfo.threeDaysAgo}`,
    "Past Days of the Week dates:",
    dateInfo.weeklyReferences,
    "Use the relative date above if the user specifies a day (e.g. 'gahapon', 'yesterday', 'last Wednesday', 'niaging Lunes'). If no date is stated, default to the Reference Date (Today).",
    "",
    "=== SYSTEM DEFAULT CONFIGURATION ===",
    `Default building: ${building || "All"}`,
    `Default paidBy: ${paidBy || "Rolly"}`,
    "Currency: Default to PHP unless another currency is explicitly specified.",
    "",
    "=== TRANSACTION TYPE & CATEGORY VOCABULARY ===",
    "You MUST choose one of the following exact [fundingNature, category] pairs:",
    validPairsList,
    "",
    "Ensure the transaction 'type' and 'transactionType' match the rules:",
    "- 'Expense' if fundingNature is OPEX, CAPEX, CAPEX-Recoverable, or Payable. (Cash outflow)",
    "- 'Income' if fundingNature is Revenue. (Cash inflow)",
    "- 'Adjustment' for short-term employee lending / cash advances ('bale', 'ca', 'c.a.'). fundingNature MUST be 'Receivable', category MUST be 'Cash Advance'. The field 'paidTo' must hold the helper/staff's name.",
    "- 'Payment' when a customer/buyer pays back their outstanding balance/receivable. fundingNature MUST be 'Receivable', category MUST be 'Reimbursement'.",
    "- 'Reimbursement' for standard reimbursements / refunds.",
    "",
    "=== VOCABULARY MAPPINGS (CEBUANO / TAGALOG / ENGLISH) ===",
    "- Feed / Feeds / Pellets / Lawog / Pakaon / Bahog / Tubog -> OPEX / Feed",
    "- DOC / Chick / Sisiw -> OPEX / DOC",
    "- Charcoal / Uling -> OPEX / Charcoal",
    "- Sweldo / Sahod / Arawan / Trabaho / Labor / Helpers -> OPEX / Labor",
    "- Food / Pagkaon / Kasalo -> OPEX / Food Expense",
    "- Water / Kuryente / Tubig / Electric / Koryente -> OPEX / Utilities",
    "- Hardware / Lumber / Plywood / Semento / Cement / Nails -> CAPEX / Hardware (unless it is explicitly stated as minor repairs)",
    "- Repair / Ayo / Paayo / Guba / Maintenance / Powersprayer / Sprayer -> OPEX / Minor Repair",
    "- Delivery / Fuel / Tubil / Gas / Gasolina / Plete / Hatod / Transpo -> OPEX / Transport (unless for powersprayer)",
    "- Gas / Diesel / Fuel for powersprayer -> OPEX / Minor Repair",
    "- Cleaning / Sabon / Chlorine / Janitorial -> OPEX / Cleaning & Janitorial",
    "- Empty sacks / Sako / Baligya sako -> Revenue / Empty Sack Sale",
    "- Chicken manure / Tae / Tae sa manok / Dung / Manure -> Revenue / Miscellaneous Income",
    "- Sold chickens / Halin sa manok / Net meat sale -> Revenue / Net Meat Sale",
    "- Bale / CA / Advance -> Receivable / Cash Advance (paidTo should be the receiver name)",
    "- Bayad utang / Paid balance / Buyer payment / Bayad sa utang -> Receivable / Reimbursement (type & transactionType = 'Payment')",
    "",
    "=== FIELDS & STRUCTURE ===",
    "- description: A short, Title Case English summary of the transaction (e.g. 'Bought 3 Bags Feed', 'Staff Cash Advance Jane', 'Sold 10 Sacks Dung').",
    "- amountSource: Use 'explicit' for a stated total, 'quantity_x_unit_price' if calculated, 'estimated' if terms like 'mga', 'siguro', 'around', 'murag' are used.",
    "- Treat shorthand unit prices like 'sold 10 trays eggs 220 each' as quantity_x_unit_price.",
    "- If both a unit price/quantity and an explicit total are present, set quantity and unitPrice, but use the explicit total for amount.",
    "- Set confidence: lower confidence (e.g. 0.5-0.7) if amount is missing, category is ambiguous, or transaction type is unclear.",
    "",
    "=== MULTILINGUAL PARSING EXAMPLES ===",
    "Example 1:",
    "Input: gahapon nipalit kog 3 ka sako nga lawog tag 1500 ang usa",
    "JSON Output:",
    JSON.stringify({
      type: "Expense",
      transactionType: "Expense",
      fundingNature: "OPEX",
      category: "Feed",
      quickCategory: "Feeds",
      description: "Purchased 3 Bags Feed",
      amount: 4500,
      quantity: 3,
      unit: "bags",
      unitPrice: 1500,
      amountSource: "quantity_x_unit_price",
      currency: "PHP",
      paymentMethod: "Cash",
      building: building || "All",
      paidBy: paidBy || "Rolly",
      paidTo: "",
      reference: "",
      remarks: "gahapon nipalit kog 3 ka sako nga lawog tag 1500 ang usa",
      date: dateInfo.yesterday,
      confidence: 0.95,
      originalText: "gahapon nipalit kog 3 ka sako nga lawog tag 1500 ang usa"
    }, null, 2),
    "",
    "Example 2:",
    "Input: bale ni Jane ug 600 ka pesos para sa iyang pamilya",
    "JSON Output:",
    JSON.stringify({
      type: "Adjustment",
      transactionType: "Adjustment",
      fundingNature: "Receivable",
      category: "Cash Advance",
      quickCategory: "Labor",
      description: "Staff Cash Advance Jane",
      amount: 600,
      quantity: null,
      unit: "",
      unitPrice: null,
      amountSource: "explicit",
      currency: "PHP",
      paymentMethod: "Cash",
      building: building || "All",
      paidBy: paidBy || "Rolly",
      paidTo: "Jane",
      reference: "",
      remarks: "bale ni Jane ug 600 ka pesos para sa iyang pamilya",
      date: dateInfo.today,
      confidence: 0.95,
      originalText: "bale ni Jane ug 600 ka pesos para sa iyang pamilya"
    }, null, 2),
    "",
    "Example 3:",
    "Input: sold 10 bags chicken dung at 50 each cash",
    "JSON Output:",
    JSON.stringify({
      type: "Income",
      transactionType: "Income",
      fundingNature: "Revenue",
      category: "Miscellaneous Income",
      quickCategory: "Other Revenue",
      description: "Sold 10 Bags Chicken Dung",
      amount: 500,
      quantity: 10,
      unit: "bags",
      unitPrice: 50,
      amountSource: "quantity_x_unit_price",
      currency: "PHP",
      paymentMethod: "Cash",
      building: building || "All",
      paidBy: paidBy || "Rolly",
      paidTo: "",
      reference: "",
      remarks: "sold 10 bags chicken dung at 50 each cash",
      date: dateInfo.today,
      confidence: 0.95,
      originalText: "sold 10 bags chicken dung at 50 each cash"
    }, null, 2),
    "",
    "Example 4:",
    "Input: bayad sa utang si Cardo 1500 gahapon gcash",
    "JSON Output:",
    JSON.stringify({
      type: "Payment",
      transactionType: "Payment",
      fundingNature: "Receivable",
      category: "Reimbursement",
      quickCategory: "Other Revenue",
      description: "Customer Payment Cardo",
      amount: 1500,
      quantity: null,
      unit: "",
      unitPrice: null,
      amountSource: "explicit",
      currency: "PHP",
      paymentMethod: "GCash",
      building: building || "All",
      paidBy: "Cardo",
      paidTo: "",
      reference: "",
      remarks: "bayad sa utang si Cardo 1500 gahapon gcash",
      date: dateInfo.yesterday,
      confidence: 0.9,
      originalText: "bayad sa utang si Cardo 1500 gahapon gcash"
    }, null, 2),
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
      type: "number",
      nullable: true,
      description: "The extracted amount. Use null only when no amount is stated.",
    },
    quantity: {
      type: "number",
      nullable: true,
      description: "Quantity if the entry states one, otherwise null.",
    },
    unitPrice: {
      type: "number",
      nullable: true,
      description: "Unit price if the entry states one, otherwise null.",
    },
    amountSource: {
      type: "string",
      enum: ["explicit", "quantity_x_unit_price", "estimated"],
      nullable: true,
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
    paidBy: cleanText(aiParsed.paidBy) || fallback.paidBy || options.paidBy || "Rolly",
    paidTo: cleanText(aiParsed.paidTo) || fallback.paidTo || "",
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
