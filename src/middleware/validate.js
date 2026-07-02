const z = require('zod');

/**
 * Generic Express middleware to validate request body using a Zod schema.
 */
const validate = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (err) {
    if (err instanceof z.ZodError) {
      const formattedErrors = err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      return res.status(400).json({ error: `Validation error: ${formattedErrors}` });
    }
    next(err);
  }
};

// Common batchId schema (accepts string or number, resolves as string)
const batchIdSchema = z.preprocess(
  (val) => (val === null || val === undefined ? undefined : String(val)),
  z.string().min(1, "Batch ID is required")
);

// Schema for transaction create/update
const transactionSchema = z.object({
  batchId: batchIdSchema.optional(),
  date: z.string().min(1, "Date is required"),
  building: z.string().optional().nullable(),
  fundingNature: z.string().min(1, "Funding nature is required"),
  category: z.string().min(1, "Category is required"),
  description: z.string().min(1, "Description is required"),
  quantity: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Quantity must be finite").nonnegative("Quantity cannot be negative").nullable().optional()
  ),
  unitCost: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Unit cost must be finite").nonnegative("Unit cost cannot be negative").nullable().optional()
  ),
  amount: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Amount must be finite").nonnegative("Amount cannot be negative").nullable().optional()
  ),
  paidBy: z.string().optional().nullable(),
  paidTo: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  feedItemId: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().int("Feed Item ID must be an integer").positive("Feed Item ID must be positive").nullable().optional()
  ),
});

// Schema for daily log create/update
const dailyLogSchema = z.object({
  batchId: batchIdSchema.optional(),
  date: z.string().min(1, "Date is required"),
  building: z.string().min(1, "Building is required"),
  employeeId: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
    z.number().int("Employee ID must be an integer").positive("Employee ID must be positive")
  ),
  handledBirds: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().int("Handled birds must be an integer").nonnegative("Handled birds cannot be negative").nullable().optional()
  ),
  feedItemId: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().int("Feed Item ID must be an integer").positive("Feed Item ID must be positive").nullable().optional()
  ),
  feed: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Feed quantity must be finite").nonnegative("Feed quantity cannot be negative")
  ),
  mortality: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Mortality must be an integer").nonnegative("Mortality count cannot be negative")
  ),
  averageWeightGrams: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Average weight must be finite").positive("Average weight must be positive").nullable().optional()
  ),
  remarks: z.string().optional().nullable(),
});

// Loading item schema
const loadingItemSchema = z.object({
  building: z.string().optional().nullable(),
  buildingName: z.string().optional().nullable(),
  chicksLoaded: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Chicks loaded must be an integer").nonnegative("Chicks loaded cannot be negative")
  ),
  chicks_loaded: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Chicks loaded must be an integer").nonnegative("Chicks loaded cannot be negative")
  ).optional(),
  doaCount: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("DOA count must be an integer").nonnegative("DOA count cannot be negative")
  ).optional(),
  netChicksPlaced: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Net chicks placed must be an integer").nonnegative("Net chicks placed cannot be negative")
  ).optional(),
  sampleWeightGrams: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Sample weight must be finite").positive("Sample weight must be greater than zero").nullable()
  ).optional(),
  loadingSharePct: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Share percentage must be finite").nonnegative("Share percentage cannot be negative").max(100, "Share percentage cannot exceed 100")
  ),
  loading_share_pct: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Share percentage must be finite").nonnegative("Share percentage cannot be negative").max(100, "Share percentage cannot exceed 100")
  ).optional(),
  remarks: z.string().optional().nullable(),
});

// Schema for batch create
const batchSchema = z.object({
  startDate: z.string().min(1, "Start date is required"),
  targetHarvestDate: z.string().optional().nullable(),
  totalChicksLoaded: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Total chicks loaded must be an integer").nonnegative("Total chicks loaded cannot be negative")
  ),
  actualChicksArrived: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Actual chicks arrived must be an integer").nonnegative("Actual chicks arrived cannot be negative")
  ).optional(),
  doaCount: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("DOA count must be an integer").nonnegative("DOA count cannot be negative")
  ).optional(),
  netChicksPlaced: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Net chicks placed must be an integer").nonnegative("Net chicks placed cannot be negative")
  ).optional(),
  arrivalSampleWeightGrams: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Arrival sample weight must be finite").positive("Arrival sample weight must be greater than zero").nullable()
  ).optional(),
  plannedFlock: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Planned flock must be an integer").nonnegative("Planned flock cannot be negative")
  ),
  mortalityAllowance: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Mortality allowance must be an integer").nonnegative("Mortality allowance cannot be negative")
  ).optional(),
  targetFeedKg: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Target feed must be finite").nonnegative("Target feed cannot be negative")
  ),
  notes: z.string().optional().nullable(),
  status: z.string().optional(),
  loadings: z.array(loadingItemSchema).optional().nullable(),
});

// Schema for batch loadings PUT
const batchLoadingsSchema = z.object({
  loadings: z.array(loadingItemSchema),
});

// Harvest nested sale rows schemas
const chickenSaleSchema = z.object({
  item: z.string().min(1, "Chicken item name is required"),
  basePricePerKg: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Price per kg must be finite").nonnegative("Price per kg cannot be negative")
  ),
  harvest1Birds: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Birds count must be an integer").nonnegative("Birds count cannot be negative")
  ),
  harvest1Kilos: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Kilos must be finite").nonnegative("Kilos cannot be negative")
  ),
  harvest2Birds: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Birds count must be an integer").nonnegative("Birds count cannot be negative")
  ),
  harvest2Kilos: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Kilos must be finite").nonnegative("Kilos cannot be negative")
  ),
  harvest3Birds: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().int("Birds count must be an integer").nonnegative("Birds count cannot be negative")
  ),
  harvest3Kilos: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Kilos must be finite").nonnegative("Kilos cannot be negative")
  ),
  finalRate: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Final rate must be finite").nonnegative("Final rate cannot be negative").nullable().optional()
  ),
  notes: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

const byproductSaleSchema = z.object({
  item: z.string().min(1, "Byproduct item name is required"),
  price: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Price must be finite").nonnegative("Price cannot be negative")
  ).optional(),
  originalRate: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Original rate must be finite").nonnegative("Original rate cannot be negative")
  ).optional(),
  harvest1Qty: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Quantity must be finite").nonnegative("Quantity cannot be negative")
  ),
  harvest1Sales: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Sales must be finite").nonnegative("Sales cannot be negative")
  ),
  harvest2Qty: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Quantity must be finite").nonnegative("Quantity cannot be negative")
  ),
  harvest2Sales: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Sales must be finite").nonnegative("Sales cannot be negative")
  ),
  harvest3Qty: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Quantity must be finite").nonnegative("Quantity cannot be negative")
  ),
  harvest3Sales: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Sales must be finite").nonnegative("Sales cannot be negative")
  ),
  finalRate: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Final rate must be finite").nonnegative("Final rate cannot be negative").nullable().optional()
  ),
  notes: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

const harvestEventSchema = z.object({
  harvestOrder: z.number().int().positive("Harvest order must be positive"),
  harvestDate: z.string().optional().nullable(),
  permitShipping: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Permit shipping must be finite").nonnegative("Permit shipping fee cannot be negative")
  ),
  tollingFee: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Tolling fee must be finite").nonnegative("Tolling fee cannot be negative")
  ),
  remarks: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const financingItemSchema = z.object({
  item: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  quantity: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Quantity must be finite").nonnegative("Quantity cannot be negative").nullable().optional()
  ),
  unitCost: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Unit cost must be finite").nonnegative("Unit cost cannot be negative").nullable().optional()
  ),
  amount: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Amount must be finite").nonnegative("Amount cannot be negative")
  ),
  notes: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

// Schema for harvest report PUT
const harvestReportSchema = z.object({
  docAddOnRatePerBird: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("DOC add-on rate must be finite").nonnegative("DOC add-on rate cannot be negative")
  ),
  truckingFeePerBird: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Trucking fee must be finite").nonnegative("Trucking fee cannot be negative")
  ),
  sourceFilename: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  chickenSales: z.array(chickenSaleSchema).optional().nullable(),
  byproductSales: z.array(byproductSaleSchema).optional().nullable(),
  harvestEvents: z.array(harvestEventSchema).optional().nullable(),
  financingItems: z.array(financingItemSchema).optional().nullable(),
});

// Schema for inventory item create/update
const inventoryItemSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().min(1, "Category is required"),
  unit: z.string().min(1, "Unit is required"),
  targetQuantity: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Target quantity must be finite").nonnegative("Target quantity cannot be negative")
  ).optional().nullable(),
  reorderLevel: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 0 : Number(val)),
    z.number().finite("Reorder level must be finite").nonnegative("Reorder level cannot be negative")
  ).optional().nullable(),
  isActive: z.boolean().optional(),
});

// Schema for inventory movement POST
const inventoryMovementSchema = z.object({
  batchId: batchIdSchema.optional().nullable(),
  itemId: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
    z.number().int("Item ID must be an integer").positive("Item ID must be positive")
  ),
  movementDate: z.string().min(1, "Movement date is required"),
  movementType: z.string().min(1, "Movement type is required"),
  quantity: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
    z.number().finite("Quantity must be finite").positive("Quantity must be greater than zero")
  ),
  unitCost: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Unit cost must be finite").nonnegative("Unit cost cannot be negative").nullable().optional()
  ),
  amount: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().finite("Amount must be finite").nonnegative("Amount cannot be negative").nullable().optional()
  ),
  building: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  createLedger: z.boolean().optional(),
  fundingNature: z.string().optional().nullable(),
  ledgerCategory: z.string().optional().nullable(),
  paidBy: z.string().optional().nullable(),
  paidTo: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
});

// Schema for friendly expenses API create/update
const expenseSchema = z.object({
  batchId: batchIdSchema.optional().nullable(),
  description: z.string().min(1, "Description is required"),
  category: z.string().min(1, "Category is required"),
  vendor: z.string().optional().nullable(),
  date: z.string().min(1, "Date is required"),
  amount: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
    z.number().finite("Amount must be finite").positive("Amount must be greater than zero")
  ),
  notes: z.string().optional().nullable(),
});

// Schema for employee create/update
const employeeSchema = z.object({
  name: z.string().min(1, "Name is required"),
  displayName: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  position: z.string().optional().nullable(),
  hireDate: z.string().optional().nullable(),
  assignedBuilding: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// Schema for employee compensation PUT
const employeeCompensationSchema = z.object({
  handledBirds: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? null : Number(val)),
    z.number().int("Handled birds count must be an integer").nonnegative("Handled birds count cannot be negative").nullable().optional()
  ),
  ratePerBird: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
    z.number().finite("Rate per bird must be finite").nonnegative("Rate per bird cannot be negative").optional()
  ),
  corpoGroup: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
});

module.exports = {
  validate,
  transactionSchema,
  dailyLogSchema,
  batchSchema,
  batchLoadingsSchema,
  harvestReportSchema,
  inventoryItemSchema,
  inventoryMovementSchema,
  expenseSchema,
  employeeSchema,
  employeeCompensationSchema,
};
