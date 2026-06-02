const { toDateOnly } = require('../utils/validation');
const { toNumber, toFiniteNumber, toNullableFiniteNumber, roundMoney } = require('../utils/money');

function mapHarvestEvent(row) {
  return {
    id: row.id || null,
    harvestOrder: Number(row.harvestOrder || row.harvest_order || 0),
    harvestDate: toDateOnly(row.harvestDate || row.harvest_date) || '',
    permitShipping: toFiniteNumber(row.permitShipping ?? row.permit_shipping),
    tollingFee: toFiniteNumber(row.tollingFee ?? row.tolling_fee),
    remarks: row.remarks || '',
  };
}

function mapHarvestChickenSale(row) {
  return {
    id: row.id || null,
    item: row.item || '',
    basePricePerKg: row.basePricePerKg ?? row.base_price_per_kg ?? '',
    harvest1Birds: Number(row.harvest1Birds ?? row.harvest1_birds ?? 0),
    harvest1Kilos: toFiniteNumber(row.harvest1Kilos ?? row.harvest1_kilos),
    harvest2Birds: Number(row.harvest2Birds ?? row.harvest2_birds ?? 0),
    harvest2Kilos: toFiniteNumber(row.harvest2Kilos ?? row.harvest2_kilos),
    harvest3Birds: Number(row.harvest3Birds ?? row.harvest3_birds ?? 0),
    harvest3Kilos: toFiniteNumber(row.harvest3Kilos ?? row.harvest3_kilos),
    finalRate: row.finalRate ?? row.final_rate ?? '',
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
  };
}

function mapHarvestByproduct(row) {
  return {
    id: row.id || null,
    item: row.item || '',
    originalRate: row.originalRate ?? row.original_rate ?? '',
    harvest1Qty: toFiniteNumber(row.harvest1Qty ?? row.harvest1_qty),
    harvest1Sales: toFiniteNumber(row.harvest1Sales ?? row.harvest1_sales),
    harvest2Qty: toFiniteNumber(row.harvest2Qty ?? row.harvest2_qty),
    harvest2Sales: toFiniteNumber(row.harvest2Sales ?? row.harvest2_sales),
    harvest3Qty: toFiniteNumber(row.harvest3Qty ?? row.harvest3_qty),
    harvest3Sales: toFiniteNumber(row.harvest3Sales ?? row.harvest3_sales),
    finalRate: row.finalRate ?? row.final_rate ?? '',
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
  };
}

function mapHarvestFinancingItem(row) {
  return {
    id: row.id || null,
    item: row.item || '',
    category: row.category || 'Miscellaneous',
    quantity: row.quantity ?? '',
    unitCost: row.unitCost ?? row.unit_cost ?? '',
    amount: row.amount ?? '',
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
  };
}

function getFinancingAmount(row) {
  const explicitAmount = toNullableFiniteNumber(row.amount);
  if (explicitAmount !== null) return explicitAmount;

  const quantity = toNullableFiniteNumber(row.quantity);
  const unitCost = toNullableFiniteNumber(row.unitCost);
  if (quantity !== null && unitCost !== null) return quantity * unitCost;

  return 0;
}

function getDefaultHarvestEvents(batch) {
  const firstHarvestDate = toDateOnly(batch?.targetHarvestDate || batch?.target_harvest_date || batch?.actualHarvestEndDate || batch?.actual_harvest_end_date);

  return [0, 1, 2].map((_, index) => ({
    harvestOrder: index + 1,
    harvestDate: index === 0 ? firstHarvestDate || '' : '',
    permitShipping: 0,
    tollingFee: 0,
    remarks: '',
  }));
}

function calculateHarvestSummary(report) {
  const events = (report.harvestEvents || []).map(mapHarvestEvent).sort((a, b) => a.harvestOrder - b.harvestOrder);
  const chickenRows = (report.chickenSales || []).map(mapHarvestChickenSale);
  const byproductRows = (report.byproductSales || []).map(mapHarvestByproduct);
  const docRate = toFiniteNumber(report.docAddOnRatePerBird ?? report.doc_add_on_rate_per_bird, 3);
  const truckingRate = toFiniteNumber(report.truckingFeePerBird ?? report.trucking_fee_per_bird, 2.7);

  const perHarvest = [1, 2, 3].map((harvestOrder) => {
    const event = events.find((item) => Number(item.harvestOrder) === harvestOrder) || { harvestOrder };
    const birdsKey = `harvest${harvestOrder}Birds`;
    const kilosKey = `harvest${harvestOrder}Kilos`;
    const qtyKey = `harvest${harvestOrder}Qty`;
    const salesKey = `harvest${harvestOrder}Sales`;
    const birds = chickenRows.reduce((sum, row) => sum + Math.round(toFiniteNumber(row[birdsKey])), 0);
    const kilos = chickenRows.reduce((sum, row) => sum + toFiniteNumber(row[kilosKey]), 0);
    const chickenSales = chickenRows.reduce((sum, row) => {
      const rate = toFiniteNumber(row.finalRate, toFiniteNumber(row.basePricePerKg));
      return sum + (toFiniteNumber(row[kilosKey]) * rate);
    }, 0);
    const byproductSales = byproductRows.reduce((sum, row) => sum + toFiniteNumber(row[salesKey]), 0);
    const byproductQty = byproductRows.reduce((sum, row) => sum + toFiniteNumber(row[qtyKey]), 0);
    const grossSales = chickenSales + byproductSales;
    const docAddOn = birds * docRate;
    const truckingFee = birds * truckingRate;
    const permitShipping = toFiniteNumber(event.permitShipping);
    const tollingFee = toFiniteNumber(event.tollingFee);
    const totalExpenses = permitShipping + tollingFee + docAddOn + truckingFee;
    const netSales = grossSales - totalExpenses;

    return {
      harvestOrder,
      harvestDate: event.harvestDate || '',
      birds,
      kilos: Number(kilos.toFixed(3)),
      chickenSales: roundMoney(chickenSales),
      byproductQty: Number(byproductQty.toFixed(3)),
      byproductSales: roundMoney(byproductSales),
      grossSales: roundMoney(grossSales),
      permitShipping: roundMoney(permitShipping),
      tollingFee: roundMoney(tollingFee),
      docAddOn: roundMoney(docAddOn),
      truckingFee: roundMoney(truckingFee),
      totalExpenses: roundMoney(totalExpenses),
      netSales: roundMoney(netSales),
    };
  });

  const totals = perHarvest.reduce((sum, row) => ({
    birds: sum.birds + row.birds,
    kilos: sum.kilos + row.kilos,
    chickenSales: sum.chickenSales + row.chickenSales,
    byproductQty: sum.byproductQty + row.byproductQty,
    byproductSales: sum.byproductSales + row.byproductSales,
    grossSales: sum.grossSales + row.grossSales,
    permitShipping: sum.permitShipping + row.permitShipping,
    tollingFee: sum.tollingFee + row.tollingFee,
    docAddOn: sum.docAddOn + row.docAddOn,
    truckingFee: sum.truckingFee + row.truckingFee,
    totalExpenses: sum.totalExpenses + row.totalExpenses,
    netSales: sum.netSales + row.netSales,
  }), {
    birds: 0,
    kilos: 0,
    chickenSales: 0,
    byproductQty: 0,
    byproductSales: 0,
    grossSales: 0,
    permitShipping: 0,
    tollingFee: 0,
    docAddOn: 0,
    truckingFee: 0,
    totalExpenses: 0,
    netSales: 0,
  });

  totals.kilos = Number(totals.kilos.toFixed(3));
  totals.byproductQty = Number(totals.byproductQty.toFixed(3));

  return { perHarvest, totals };
}

async function getHarvestReport(client, farmId, batchId) {
  // Lazy require to avoid circular dependency (batches.service → harvest.service → batches.service)
  const { mapBatch } = require('./batches.service');
  const batch = await client.query(
    'SELECT id, status, target_harvest_date, actual_harvest_end_date FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1',
    [batchId, farmId]
  );

  if (batch.rowCount === 0) return null;

  const reportResult = await client.query(
    'SELECT * FROM harvest_reports WHERE batch_id = $1 AND farm_id = $2 LIMIT 1',
    [batchId, farmId]
  );

  if (reportResult.rowCount === 0) {
    const defaultEvents = getDefaultHarvestEvents(mapBatch(batch.rows[0]));
    return {
      docAddOnRatePerBird: 3,
      truckingFeePerBird: 2.7,
      notes: '',
      status: 'Draft',
      harvestEvents: defaultEvents,
      chickenSales: [],
      byproductSales: [],
      financingItems: [],
      summary: calculateHarvestSummary({
        docAddOnRatePerBird: 3,
        truckingFeePerBird: 2.7,
        harvestEvents: defaultEvents,
      }),
    };
  }

  const report = reportResult.rows[0];
  const [events, chickenSales, byproductSales, financingItems] = await Promise.all([
    client.query('SELECT * FROM harvest_report_events WHERE report_id = $1 ORDER BY harvest_order', [report.id]),
    client.query('SELECT * FROM harvest_chicken_sales WHERE report_id = $1 ORDER BY sort_order', [report.id]),
    client.query('SELECT * FROM harvest_byproduct_sales WHERE report_id = $1 ORDER BY sort_order', [report.id]),
    client.query('SELECT * FROM harvest_financing_items WHERE report_id = $1 ORDER BY sort_order', [report.id]),
  ]);

  const output = {
    id: report.id,
    sourceFilename: report.source_filename || '',
    docAddOnRatePerBird: toNumber(report.doc_add_on_rate_per_bird),
    truckingFeePerBird: toNumber(report.trucking_fee_per_bird),
    notes: report.notes || '',
    status: report.status || 'Draft',
    harvestEvents: events.rows.map(mapHarvestEvent),
    chickenSales: chickenSales.rows.map(mapHarvestChickenSale),
    byproductSales: byproductSales.rows.map(mapHarvestByproduct),
    financingItems: financingItems.rows.map(mapHarvestFinancingItem),
  };

  output.summary = calculateHarvestSummary(output);
  return output;
}

async function getHarvestProductionSummary(client, farmId, batchId) {
  const report = await getHarvestReport(client, farmId, batchId);
  return report ? report.summary : null;
}

function getLatestHarvestDate(harvestRows) {
  const dates = harvestRows.map((r) => r.harvestDate).filter(Boolean);
  if (dates.length === 0) return '';
  return dates.reduce((max, d) => (d > max ? d : max), dates[0]);
}

function getOrdinalLabel(value) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = Number(value) || 0;
  const lastDigit = v % 10;
  const lastTwoDigits = v % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return `${v}th`;
  return `${v}${suffixes[lastDigit] || 'th'}`;
}

module.exports = {
  mapHarvestEvent,
  mapHarvestChickenSale,
  mapHarvestByproduct,
  mapHarvestFinancingItem,
  getFinancingAmount,
  getDefaultHarvestEvents,
  calculateHarvestSummary,
  getHarvestReport,
  getHarvestProductionSummary,
  getLatestHarvestDate,
  getOrdinalLabel,
};
