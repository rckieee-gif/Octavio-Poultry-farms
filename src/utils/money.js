function toNumber(value) {
  if (value === null || value === undefined) return value;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? null : numberValue;
}

function toFiniteNumber(value, fallback = 0) {
  if (value === '' || value === undefined || value === null) return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toNullableFiniteNumber(value) {
  if (value === '' || value === undefined || value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function roundMoney(value) {
  return Number(toFiniteNumber(value).toFixed(2));
}

function hasQuantityAndUnitCost(quantity, unitCost) {
  return quantity !== '' &&
    quantity !== undefined &&
    quantity !== null &&
    unitCost !== '' &&
    unitCost !== undefined &&
    unitCost !== null;
}

function calculateAmount({ quantity, unitCost, amount, manualAmount }) {
  const parsedQuantity = quantity === '' || quantity === undefined || quantity === null ? null : Number(quantity);
  const parsedUnitCost = unitCost === '' || unitCost === undefined || unitCost === null ? null : Number(unitCost);

  if (hasQuantityAndUnitCost(quantity, unitCost)) {
    return Number((parsedQuantity * parsedUnitCost).toFixed(2));
  }

  const inputAmount = amount ?? manualAmount;
  if (inputAmount === '' || inputAmount === undefined || inputAmount === null) {
    throw new Error('Amount is required when quantity and unit cost are not both provided.');
  }

  return Number(Number(inputAmount).toFixed(2));
}

module.exports = {
  toNumber,
  toFiniteNumber,
  toNullableFiniteNumber,
  roundMoney,
  hasQuantityAndUnitCost,
  calculateAmount,
};
