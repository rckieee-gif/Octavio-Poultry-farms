const {
  categories,
  octavioLedgerCategories,
  groupOctavioCategories,
} = require("./quickEntryCategories");

const CATEGORY_RULES = [
  {
    quickCategory: "Other Revenue",
    fundingNature: "Receivable",
    category: "Reimbursement",
    allowedTypes: ["Payment"],
    patterns: [
      /\bcustomer\b/i,
      /\bbalance\b/i,
      /\bpaid balance\b/i,
      /\bpayment\b/i,
    ],
  },
  {
    quickCategory: "Sales Revenue",
    fundingNature: "Revenue",
    category: "Miscellaneous Income",
    allowedTypes: ["Income"],
    patterns: [
      /\bchicken dung\b/i,
      /\bmanure\b/i,
      /\babono\b/i,
    ],
  },
  {
    quickCategory: "Sales Revenue",
    fundingNature: "Revenue",
    category: "Empty Sack Sale",
    allowedTypes: ["Income"],
    patterns: [/\bempty sacks?\b/i],
  },
  {
    quickCategory: "Sales Revenue",
    fundingNature: "Revenue",
    category: "Net Meat Sale",
    allowedTypes: ["Income"],
    patterns: [
      /\bsold\b/i,
      /\bbaligya\b/i,
      /\bhalin\b/i,
      /\bkinita\b/i,
      /\bsale\b/i,
      /\bsales\b/i,
      /\brevenue\b/i,
      /\bincome\b/i,
      /\breceived\b/i,
      /\bearned\b/i,
      /\bmeat\b/i,
      /\bchickens?\b/i,
      /\bmanok\b/i,
    ],
  },
  {
    quickCategory: "Feeds",
    fundingNature: "OPEX",
    category: "Feed",
    allowedTypes: ["Expense"],
    patterns: [
      /\bfeeds?\b/i,
      /\bpakaon\b/i,
      /\bpagkaon\b/i,
      /\bpellets?\b/i,
      /\bmash\b/i,
      /\bcorn\b/i,
      /\bbran\b/i,
      /\bstarter\b/i,
      /\bgrower\b/i,
    ],
  },
  {
    quickCategory: "Medicine / Vet",
    fundingNature: "OPEX",
    category: "Medicine",
    allowedTypes: ["Expense"],
    patterns: [
      /\bmedicine\b/i,
      /\btambal\b/i,
      /\bgamot\b/i,
      /\bmeds?\b/i,
      /\bvet\b/i,
      /\bveterinary\b/i,
      /\bvaccine\b/i,
      /\bvitamins?\b/i,
      /\bantibiotics?\b/i,
      /\btreatment\b/i,
    ],
  },
  {
    quickCategory: "Labor",
    fundingNature: "OPEX",
    category: "Labor",
    allowedTypes: ["Expense"],
    patterns: [
      /\blabo[u]?r\b/i,
      /\bsweldo\b/i,
      /\bsahod\b/i,
      /\bwages?\b/i,
      /\bsalar(?:y|ies)\b/i,
      /\bworker\b/i,
      /\bhelper\b/i,
      /\bcaretaker\b/i,
      /\bpayroll\b/i,
    ],
  },
  {
    quickCategory: "Repairs and Maintenance",
    fundingNature: "OPEX",
    category: "Minor Repair",
    allowedTypes: ["Expense"],
    patterns: [
      /\brepairs?\b/i,
      /\bpaayo\b/i,
      /\bgipaayo\b/i,
      /\binayo\b/i,
      /\bmaintenance\b/i,
      /\bfix(?:ed|ing)?\b/i,
      /\bnails?\b/i,
      /\bcarpenter\b/i,
      /\bwelding\b/i,
    ],
  },
  {
    quickCategory: "Repairs and Maintenance",
    fundingNature: "CAPEX",
    category: "Building Repair",
    allowedTypes: ["Expense"],
    patterns: [
      /\bbuilding repair\b/i,
      /\bpoultry house\b/i,
      /\brenovation\b/i,
      /\bconstruction\b/i,
      /\broof(?:ing)?\b/i,
    ],
  },
  {
    quickCategory: "Supplies",
    fundingNature: "OPEX",
    category: "Charcoal",
    allowedTypes: ["Expense"],
    patterns: [
      /\bcharcoal\b/i,
      /\buling\b/i,
    ],
  },
  {
    quickCategory: "Supplies",
    fundingNature: "CAPEX",
    category: "Hardware",
    allowedTypes: ["Expense"],
    patterns: [
      /\bhardware\b/i,
      /\blumber\b/i,
      /\bplywood\b/i,
      /\bwood\b/i,
      /\bcement\b/i,
    ],
  },
  {
    quickCategory: "Utilities",
    fundingNature: "OPEX",
    category: "Utilities",
    allowedTypes: ["Expense"],
    patterns: [
      /\belectric(?:ity)?\b/i,
      /\bkuryente\b/i,
      /\btubig\b/i,
      /\bpower\b/i,
      /\bwater\b/i,
      /\butilit(?:y|ies)\b/i,
      /\bbill\b/i,
      /\binternet\b/i,
    ],
  },
  {
    quickCategory: "Transport",
    fundingNature: "OPEX",
    category: "Transport",
    allowedTypes: ["Expense"],
    patterns: [
      /\btransport\b/i,
      /\bplete\b/i,
      /\bhatod\b/i,
      /\bbiyahe\b/i,
      /\bdelivery\b/i,
      /\bfare\b/i,
      /\btruck(?:ing)?\b/i,
      /\bfuel\b/i,
      /\bdiesel\b/i,
      /\bgasoline\b/i,
      /\bparking\b/i,
    ],
  },
  {
    quickCategory: "Supplies",
    fundingNature: "OPEX",
    category: "Supplies",
    allowedTypes: ["Expense"],
    patterns: [
      /\bsupplies\b/i,
      /\bgamit\b/i,
      /\bdisinfectant\b/i,
      /\bcleaning\b/i,
      /\bgloves?\b/i,
      /\bsacks?\b/i,
      /\btrays?\b/i,
      /\bbedding\b/i,
      /\bstraw\b/i,
    ],
  },
  {
    quickCategory: "Equipment",
    fundingNature: "CAPEX",
    category: "Equipment",
    allowedTypes: ["Expense"],
    patterns: [
      /\bequipment\b/i,
      /\bcages?\b/i,
      /\bfeeders?\b/i,
      /\bdrinkers?\b/i,
      /\bbrooders?\b/i,
      /\bincubators?\b/i,
      /\bfans?\b/i,
      /\btools?\b/i,
      /\bscale\b/i,
    ],
  },
];

const EXPENSE_PATTERNS = [
  /\bbought\b/i,
  /\bnipalit\b/i,
  /\bnagpalit\b/i,
  /\bgipalit\b/i,
  /\bbumili\b/i,
  /\bbinili\b/i,
  /\bbuy\b/i,
  /\bpurchased\b/i,
  /\bpaid\b/i,
  /\bnagbayad\b/i,
  /\bmayad\b/i,
  /\bbinayad\b/i,
  /\bspent\b/i,
  /\bcost\b/i,
  /\bexpense\b/i,
];

const REVENUE_PATTERNS = [
  /\bsold\b/i,
  /\bbaligya\b/i,
  /\bhalin\b/i,
  /\bnakabaligya\b/i,
  /\bsale\b/i,
  /\bsales\b/i,
  /\breceived\b/i,
  /\bincome\b/i,
  /\brevenue\b/i,
  /\bearned\b/i,
];

const MONTHS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const WEEKDAYS = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function parseQuickEntry(text, options = {}) {
  const originalText = String(text || "").trim();
  const today = options.today || toLocalDate(new Date());
  const amountResult = extractAmount(originalText);
  const type = inferTransactionType(originalText);
  const categoryMatch = inferCategory(originalText, type);
  const description = buildDescription(originalText, amountResult, categoryMatch);
  const confidence = scoreConfidence({
    originalText,
    amountResult,
    category: categoryMatch.category,
    description,
  });

  return {
    type,
    transactionType: type,
    fundingNature: categoryMatch.fundingNature,
    category: categoryMatch.category,
    quickCategory: categoryMatch.quickCategory,
    description,
    amount: amountResult.amount,
    quantity: amountResult.quantity,
    unit: amountResult.unit,
    unitPrice: amountResult.unitPrice,
    amountSource: amountResult.amountSource,
    currency: amountResult.currency,
    paymentMethod: "Cash",
    building: options.building || "All",
    paidBy: options.paidBy || "Rolly",
    paidTo: options.paidTo || "",
    reference: "",
    remarks: "",
    date: inferDate(originalText, today),
    confidence,
    originalText,
  };
}

function quickEntryResponse(text, options = {}) {
  const parsed = parseQuickEntry(text, options);
  return {
    parsed: {
      type: parsed.type,
      transactionType: parsed.transactionType,
      fundingNature: parsed.fundingNature,
      category: parsed.category,
      quickCategory: parsed.quickCategory,
      description: parsed.description,
      amount: parsed.amount,
      quantity: parsed.quantity,
      unit: parsed.unit,
      unitPrice: parsed.unitPrice,
      amountSource: parsed.amountSource,
      currency: parsed.currency,
      paymentMethod: parsed.paymentMethod,
      building: parsed.building,
      paidBy: parsed.paidBy,
      paidTo: parsed.paidTo,
      reference: parsed.reference,
      remarks: parsed.remarks,
      date: parsed.date,
      confidence: parsed.confidence,
      originalText: parsed.originalText,
    },
    needsReview: parsed.confidence < 0.75 || parsed.amount == null,
  };
}

function extractAmount(text) {
  const quantityResult = extractQuantityAndUnitPrice(text);
  const explicitResult = extractExplicitAmount(text, quantityResult);
  const isEstimated = hasEstimateMarker(text);
  const currency = inferCurrency(text);

  if (explicitResult.amount != null) {
    return {
      amount: explicitResult.amount,
      quantity: quantityResult.quantity,
      unit: quantityResult.unit,
      unitPrice: quantityResult.unitPrice,
      amountSource: isEstimated ? "estimated" : "explicit",
      currency,
      raw: joinRaw(quantityResult.raw, explicitResult.raw),
    };
  }

  if (quantityResult.quantity != null && quantityResult.unitPrice != null) {
    return {
      amount: Number((quantityResult.quantity * quantityResult.unitPrice).toFixed(2)),
      quantity: quantityResult.quantity,
      unit: quantityResult.unit,
      unitPrice: quantityResult.unitPrice,
      amountSource: isEstimated ? "estimated" : "quantity_x_unit_price",
      currency,
      raw: quantityResult.raw,
    };
  }

  return {
    amount: null,
    quantity: quantityResult.quantity,
    unit: quantityResult.unit,
    unitPrice: quantityResult.unitPrice,
    amountSource: isEstimated ? "estimated" : null,
    currency,
    raw: quantityResult.raw || "",
  };
}

function inferCurrency(text) {
  if (/\b(?:peso|pesos|php)\b|\u20b1/i.test(text)) {
    return "PHP";
  }

  return "PHP";
}

function inferTransactionType(text) {
  if (isReceivablePayment(text)) {
    return "Payment";
  }

  const hasRevenueSignal = REVENUE_PATTERNS.some((pattern) => pattern.test(text));
  const hasExpenseSignal = EXPENSE_PATTERNS.some((pattern) => pattern.test(text));

  if (hasRevenueSignal && !hasExpenseSignal) {
    return "Income";
  }

  if (hasExpenseSignal) {
    return "Expense";
  }

  return "Expense";
}

function isReceivablePayment(text) {
  return /\b(?:customer|buyer|client)\b/i.test(text) &&
    /\b(?:paid|payment|bayad|nagbayad)\b/i.test(text) &&
    /\b(?:balance|receivable|utang|kulang)\b/i.test(text);
}

function inferCategory(text, transactionType) {
  const matchingRule = CATEGORY_RULES.find((rule) =>
    (!rule.allowedTypes || rule.allowedTypes.includes(transactionType)) &&
    rule.patterns.some((pattern) => pattern.test(text)),
  );

  if (matchingRule) {
    return matchingRule;
  }

  if (transactionType === "Income") {
    return {
      quickCategory: "Other Revenue",
      fundingNature: "Revenue",
      category: "Miscellaneous Income",
    };
  }

  return {
    quickCategory: "Other Expense",
    fundingNature: "OPEX",
    category: "Miscellaneous",
  };
}

function buildDescription(text, amountResult, categoryMatch = null) {
  let description = text
    .replace(/\b(?:bought|buy|purchased|paid|spent|sold|sell|sale|sales|baligya|halin|nakabaligya|for|about|around|roughly|approximately|total|amount|cost(?:s|ed)?)\b/gi, " ")
    .replace(/\b(?:nipalit|nagpalit|gipalit|bumili|binili|nagbayad|mayad|binayad|kog|ko|ako|ng|sa|para|pang|mga|around|approx)\b/gi, " ")
    .replace(/\b(?:cash|gcash|bank|card|credit|debit)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  description = removeDatePhrases(description);

  if (amountResult.raw) {
    for (const rawPart of splitRawParts(amountResult.raw)) {
      description = description.replace(rawPart, " ");
    }
  }

  if (amountResult.quantity != null) {
    description = description.replace(new RegExp(`\\b${escapeRegExp(String(amountResult.quantity))}\\b`, "g"), " ");
  }

  if (amountResult.unit) {
    description = description.replace(new RegExp(`\\b${escapeRegExp(amountResult.unit)}s?\\b`, "gi"), " ");
  }

  if (amountResult.unitPrice != null) {
    description = description.replace(new RegExp(`\\b${escapeRegExp(String(amountResult.unitPrice))}\\b`, "g"), " ");
  }

  description = description
    .replace(/\b(?:pesos?|php|each|per|at|x|@|of)\b/gi, " ")
    .replace(/\u20b1/g, " ")
    .replace(/[.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  description = removeDatePhrases(description);
  description = normalizeLocalTerms(description);

  if (!description) {
    return categoryMatch?.category && categoryMatch.category !== "Miscellaneous"
      ? categoryMatch.category
      : "Unspecified transaction";
  }

  return toTitleCase(description);
}

function removeDatePhrases(text) {
  const monthAlternation = Object.keys(MONTHS).join("|");
  const weekdayAlternation = Object.keys(WEEKDAYS).join("|");

  return text
    .replace(/\b(?:today|this morning|karong buntag|yesterday|gahapon|kagahapon|last week|previous week|niaging semana|last semana)\b/gi, " ")
    .replace(new RegExp(`\\blast\\s+(?:${weekdayAlternation})\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${monthAlternation})\\.?\\s+[0-9]{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:[0-9]{4}|[0-9]{2}(?![0-9])))?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b[0-9]{1,2}(?:st|nd|rd|th)?\\s+(?:${monthAlternation})\\.?(?:,?\\s+(?:[0-9]{4}|[0-9]{2}(?![0-9])))?\\b`, "gi"), " ")
    .replace(/\b[0-9]{1,2}[/-][0-9]{1,2}(?:[/-][0-9]{2,4})?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocalTerms(text) {
  return text
    .replace(/\bkahoy\b/gi, "wood")
    .replace(/\btambal\b/gi, "medicine")
    .replace(/\bgamot\b/gi, "medicine")
    .replace(/\bpakaon\b/gi, "feed")
    .replace(/\bsweldo\b/gi, "labor pay")
    .replace(/\bsahod\b/gi, "labor pay")
    .replace(/\bkuryente\b/gi, "electricity")
    .replace(/\btubig\b/gi, "water")
    .replace(/\bplete\b/gi, "fare")
    .replace(/\bpaayo\b/gi, "repair")
    .replace(/\s+/g, " ")
    .trim();
}

function inferDate(text, today) {
  const isoDate = /\b(20[0-9]{2}-[01][0-9]-[0-3][0-9])\b/.exec(text);
  if (isoDate) {
    return isoDate[1];
  }

  const numericDate = parseNumericDate(text, today);
  if (numericDate) {
    return numericDate;
  }

  const monthNameDate = parseMonthNameDate(text, today);
  if (monthNameDate) {
    return monthNameDate;
  }

  if (/\b(?:yesterday|gahapon|kagahapon)\b/i.test(text)) {
    return addDays(today, -1);
  }

  if (/\b(?:last week|previous week|niaging semana|last semana)\b/i.test(text)) {
    return addDays(today, -7);
  }

  const lastWeekday = parseLastWeekday(text, today);
  if (lastWeekday) {
    return lastWeekday;
  }

  return today;
}

function parseNumericDate(text, today) {
  const match = /\b([0-9]{1,2})[/-]([0-9]{1,2})(?:[/-]([0-9]{2,4}))?\b/.exec(text);
  if (!match) {
    return null;
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = normalizeYear(match[3], today);
  let month = first;
  let day = second;

  if (first > 12 && second <= 12) {
    day = first;
    month = second;
  }

  return buildDate(year, month, day);
}

function parseMonthNameDate(text, today) {
  const monthAlternation = Object.keys(MONTHS).join("|");
  const yearPattern = "([0-9]{4}|[0-9]{2}(?![0-9]))";
  const monthDayPattern = new RegExp(`\\b(${monthAlternation})\\.?\\s+([0-9]{1,2})(?:st|nd|rd|th)?(?:,?\\s+${yearPattern})?\\b`, "i");
  const dayMonthPattern = new RegExp(`\\b([0-9]{1,2})(?:st|nd|rd|th)?\\s+(${monthAlternation})\\.?(?:,?\\s+${yearPattern})?\\b`, "i");
  const monthDay = monthDayPattern.exec(text);
  if (monthDay) {
    return buildDate(
      normalizeYear(monthDay[3], today),
      MONTHS[monthDay[1].toLowerCase()],
      Number(monthDay[2]),
    );
  }

  const dayMonth = dayMonthPattern.exec(text);
  if (dayMonth) {
    return buildDate(
      normalizeYear(dayMonth[3], today),
      MONTHS[dayMonth[2].toLowerCase()],
      Number(dayMonth[1]),
    );
  }

  return null;
}

function parseLastWeekday(text, today) {
  const weekdayAlternation = Object.keys(WEEKDAYS).join("|");
  const match = new RegExp(`\\blast\\s+(${weekdayAlternation})\\b`, "i").exec(text);
  if (!match) {
    return null;
  }

  const targetDay = WEEKDAYS[match[1].toLowerCase()];
  const date = new Date(`${today}T00:00:00`);
  const currentDay = date.getDay();
  let diff = currentDay - targetDay;

  if (diff <= 0) {
    diff += 7;
  }

  date.setDate(date.getDate() - diff);
  return toLocalDate(date);
}

function normalizeYear(value, today) {
  if (!value) {
    return Number(today.slice(0, 4));
  }

  const year = Number(value);
  if (year < 100) {
    return 2000 + year;
  }

  return year;
}

function buildDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return toLocalDate(date);
}

function addDays(today, dayOffset) {
  const date = new Date(`${today}T00:00:00`);
  date.setDate(date.getDate() + dayOffset);
  return toLocalDate(date);
}

function scoreConfidence({ originalText, amountResult, category, description }) {
  let score = 0.45;

  if (amountResult.amount != null) {
    score += 0.25;
  }

  if (amountResult.amountSource === "quantity_x_unit_price") {
    score += 0.04;
  }

  if (category !== "Miscellaneous" && category !== "Miscellaneous Income") {
    score += 0.12;
  }

  if (description && description !== "Unspecified transaction") {
    score += 0.08;
  }

  if (amountResult.amountSource === "estimated" || hasEstimateMarker(originalText)) {
    score -= 0.04;
  }

  return Math.max(0.01, Math.min(0.99, Number(score.toFixed(2))));
}

function extractExplicitAmount(text, quantityResult) {
  const explicitPatterns = [
    /\b(?:total|subtotal|amount|paid|cost(?:s|ed)?|for)\s*(?:php|\u20b1|p)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*(?:pesos?|php))?\b/i,
    /(?:php|\u20b1)\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?!\s*(?:each|ea|per|\/))/i,
    /\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:pesos?|php)\b(?!\s*(?:each|ea|per|\/))/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = pattern.exec(text);
    if (match && !overlapsQuantityPrice(match[0], quantityResult.raw)) {
      return {
        amount: parseNumber(match[1]),
        raw: match[0],
      };
    }
  }

  const numbers = [...text.matchAll(/\b[0-9][0-9,]*(?:\.[0-9]+)?\b/g)];
  if (numbers.length === 1 && quantityResult.quantity == null && quantityResult.unitPrice == null) {
    return {
      amount: parseNumber(numbers[0][0]),
      raw: numbers[0][0],
    };
  }

  return { amount: null, raw: "" };
}

function extractQuantityAndUnitPrice(text) {
  const unitPattern = "(sacks?|bags?|pcs?|pieces?|kilos?|kgs?|kg|liters?|litres?|ltr|bottles?|packs?|trays?|boxes?)";
  const itemWords = "(?:\\s+(?!x\\b|at\\b|per\\b)[a-zA-Z]+){0,4}";
  const quantityWithPricePatterns = [
    new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*${unitPattern}${itemWords}\\s*(?:x|@|at|per)\\s*(?:php|\\u20b1|p)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)(?:\\s*(?:pesos?|php))?(?:\\s*(?:each|ea))?\\b`, "i"),
    new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*${unitPattern}${itemWords}\\s+for\\s*(?:php|\\u20b1|p)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)(?:\\s*(?:pesos?|php))?\\b`, "i"),
    new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*${unitPattern}${itemWords}\\s*(?:php|\\u20b1|p)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)(?:\\s*(?:each|ea))?\\b`, "i"),
    new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*${unitPattern}${itemWords}\\s+([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(?:each|ea)\\b`, "i"),
  ];

  for (const pattern of quantityWithPricePatterns) {
    const match = pattern.exec(text);
    if (match) {
      return {
        quantity: parseNumber(match[1]),
        unit: normalizeUnit(match[2]),
        unitPrice: parseNumber(match[3]),
        raw: match[0],
      };
    }
  }

  const quantityOnly = new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*${unitPattern}\\b`, "i").exec(text);
  if (quantityOnly) {
    return {
      quantity: parseNumber(quantityOnly[1]),
      unit: normalizeUnit(quantityOnly[2]),
      unitPrice: null,
      raw: quantityOnly[0],
    };
  }

  return {
    quantity: null,
    unit: "",
    unitPrice: null,
    raw: "",
  };
}

function parseNumber(value) {
  return Number(String(value || "").replace(/,/g, ""));
}

function normalizeUnit(value) {
  const unit = String(value || "").toLowerCase();
  const unitMap = {
    sack: "sack",
    sacks: "sack",
    bag: "bag",
    bags: "bag",
    pc: "piece",
    pcs: "piece",
    piece: "piece",
    pieces: "piece",
    kilo: "kg",
    kilos: "kg",
    kg: "kg",
    kgs: "kg",
    liter: "liter",
    liters: "liter",
    litre: "liter",
    litres: "liter",
    ltr: "liter",
    bottle: "bottle",
    bottles: "bottle",
    pack: "pack",
    packs: "pack",
    tray: "tray",
    trays: "tray",
    box: "box",
    boxes: "box",
  };

  return unitMap[unit] || unit;
}

function hasEstimateMarker(text) {
  return /\b(?:about|around|roughly|approximately|approx|mga|murag|siguro|estimate|estimated)\b/i.test(text);
}

function overlapsQuantityPrice(explicitRaw, quantityRaw) {
  if (!explicitRaw || !quantityRaw) {
    return false;
  }

  return quantityRaw.toLowerCase().includes(explicitRaw.toLowerCase());
}

function joinRaw(...parts) {
  return parts.filter(Boolean).join(" ");
}

function splitRawParts(raw) {
  return raw
    .split(/\s{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTitleCase(text) {
  return text
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function toLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  categories,
  octavioLedgerCategories,
  groupOctavioCategories,
  parseQuickEntry,
  quickEntryResponse,
};
