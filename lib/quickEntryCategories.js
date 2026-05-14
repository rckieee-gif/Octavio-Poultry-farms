const quickEntryCategories = [
  "Feeds",
  "Medicine / Vet",
  "Labor",
  "Repairs and Maintenance",
  "Utilities",
  "Transport",
  "Supplies",
  "Equipment",
  "Sales Revenue",
  "Other Expense",
  "Other Revenue",
];

const octavioLedgerCategories = [
  ["OPEX", "Feed"],
  ["OPEX", "DOC"],
  ["OPEX", "Medicine"],
  ["OPEX", "Brooding Paper"],
  ["OPEX", "Charcoal"],
  ["OPEX", "Labor"],
  ["OPEX", "Food Expense"],
  ["OPEX", "Utilities"],
  ["OPEX", "Supplies"],
  ["OPEX", "Minor Repair"],
  ["OPEX", "Transport"],
  ["OPEX", "Cleaning & Janitorial"],
  ["OPEX", "Dressing Plant Expense"],
  ["OPEX", "Miscellaneous"],
  ["CAPEX", "Building Repair"],
  ["CAPEX", "Equipment"],
  ["CAPEX", "Hardware"],
  ["CAPEX", "Farm Improvement"],
  ["Receivable", "Cash Advance"],
  ["Receivable", "Reimbursement"],
  ["Payable", "Supplier Credit"],
  ["Payable", "Owner Paid Expense"],
  ["Payable", "Reimbursement Due"],
  ["Payable", "Previous Deficit"],
  ["Revenue", "Net Meat Sale"],
  ["Revenue", "Empty Sack Sale"],
  ["Revenue", "Miscellaneous Income"],
  ["CAPEX-Recoverable", "Recoverable Hardware"],
  ["CAPEX-Recoverable", "Recoverable Equipment"],
];

function groupOctavioCategories() {
  return octavioLedgerCategories.reduce((groups, [fundingNature, name]) => {
    if (!groups[fundingNature]) {
      groups[fundingNature] = [];
    }
    groups[fundingNature].push(name);
    return groups;
  }, {});
}

module.exports = {
  categories: quickEntryCategories,
  quickEntryCategories,
  octavioLedgerCategories,
  groupOctavioCategories,
};
