/**
 * Pure financial calculations for statements.
 * No MongoDB. No PDF. No AI. No estimation.
 *
 * @param {Array<object>} entries Confirmed Entry documents (or plain objects)
 */
export function calculateStatementTotals(entries = []) {
  let totalIncome = 0;
  let totalExpenses = 0;
  const expenseByCategory = new Map();

  for (const entry of entries) {
    const amount = Number(entry.amount) || 0;
    if (entry.type === 'income') {
      totalIncome += amount;
      continue;
    }
    if (entry.type === 'expense') {
      totalExpenses += amount;
      const key = (entry.category || 'uncategorized').trim().toLowerCase();
      const label = entry.category || 'Uncategorized';
      const current = expenseByCategory.get(key) || { category: label, total: 0 };
      current.total += amount;
      // Prefer first non-empty display label casing
      if (!current.category && label) {
        current.category = label;
      }
      expenseByCategory.set(key, current);
    }
  }

  const expenseBreakdown = [...expenseByCategory.values()].sort((a, b) =>
    a.category.localeCompare(b.category),
  );

  return {
    totalIncome,
    totalExpenses,
    netIncome: totalIncome - totalExpenses,
    expenseBreakdown,
    transactionCount: entries.length,
    incomeCount: entries.filter((e) => e.type === 'income').length,
    expenseCount: entries.filter((e) => e.type === 'expense').length,
  };
}

export default {
  calculateStatementTotals,
};
