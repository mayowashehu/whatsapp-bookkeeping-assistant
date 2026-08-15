import { formatNaira } from '../utils/currencyFormatter.js';
import { formatLagosDisplayDate } from '../utils/dateFormatter.js';

export function formatStatement({ property, reportingPeriod, generatedAt = new Date(), entries = [], totals }) {
  const transactions = entries.map((entry) => ({
    date: formatLagosDisplayDate(entry.transactionDate),
    dateRaw: entry.transactionDate,
    type: entry.type === 'income' ? 'Income' : 'Expense',
    typeRaw: entry.type,
    category: entry.type === 'income' ? '—' : entry.category || '—',
    description: entry.description || '—',
    amount: Number(entry.amount) || 0,
    amountFormatted: formatNaira(entry.amount),
  }));

  const expenseBreakdown = (totals.expenseBreakdown || []).map((row) => ({
    category: row.category,
    total: row.total,
    totalFormatted: formatNaira(row.total),
  }));

  return {
    header: {
      brandName: 'LUXE BNB AND CONCIERGE SERVICE',
      propertyName: property.name,
      reportingPeriod: reportingPeriod.label,
      currency: 'NGN',
      generatedAt: formatLagosDisplayDate(generatedAt),
      generatedAtRaw: generatedAt,
    },
    summary: {
      totalIncome: totals.totalIncome,
      totalExpenses: totals.totalExpenses,
      netIncome: totals.netIncome,
      totalIncomeFormatted: formatNaira(totals.totalIncome),
      totalExpensesFormatted: formatNaira(totals.totalExpenses),
      netIncomeFormatted: formatNaira(totals.netIncome),
      transactionCount: totals.transactionCount,
      isProfitable: totals.netIncome >= 0,
    },
    expenseBreakdown,
    transactions,
    footer: {
      text: 'LUXE BNB AND CONCIERGE SERVICE — Automated Financial Report',
    },
  };
}

export function toStatementSummary(formatted, property, reportingPeriod) {
  return {
    property: { id: String(property._id || property.id), name: property.name },
    reportingPeriod: {
      label: reportingPeriod.label,
      year: reportingPeriod.year,
      month: reportingPeriod.month,
      startDate: reportingPeriod.startDate,
      endDate: reportingPeriod.endDate,
    },
    totalIncome: formatted.summary.totalIncome,
    totalExpenses: formatted.summary.totalExpenses,
    netIncome: formatted.summary.netIncome,
    transactionCount: formatted.summary.transactionCount,
  };
}

export default { formatStatement, toStatementSummary };
