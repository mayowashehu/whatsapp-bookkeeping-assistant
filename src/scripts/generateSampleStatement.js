import fs from 'node:fs';
import { calculateStatementTotals } from '../statement/StatementCalculator.js';
import { formatStatement, toStatementSummary } from '../statement/StatementFormatter.js';
import { resolveCalendarMonthBounds } from '../statement/statementPeriod.js';
import { generateStatementPdf } from '../pdf/PDFGenerator.js';

/**
 * Generates a realistic sample PDF for manual review (no MongoDB required).
 * Run: node src/scripts/generateSampleStatement.js
 */
const property = { _id: '507f1f77bcf86cd799439011', name: 'Apartment 2' };
const period = resolveCalendarMonthBounds(2026, 7);

const entries = [
  {
    type: 'income',
    amount: 500000,
    category: null,
    description: 'July rent',
    transactionDate: new Date('2026-07-01T11:00:00+01:00'),
  },
  {
    type: 'expense',
    amount: 20000,
    category: 'Cleaning',
    description: 'Monthly cleaning',
    transactionDate: new Date('2026-07-03T11:00:00+01:00'),
  },
  {
    type: 'expense',
    amount: 15000,
    category: 'Repairs',
    description: 'Plumber',
    transactionDate: new Date('2026-07-08T11:00:00+01:00'),
  },
  {
    type: 'expense',
    amount: 8000,
    category: 'Electricity',
    description: 'Prepaid units',
    transactionDate: new Date('2026-07-12T11:00:00+01:00'),
  },
  {
    type: 'income',
    amount: 25000,
    category: null,
    description: 'Service charge recovery',
    transactionDate: new Date('2026-07-15T11:00:00+01:00'),
  },
];

for (let i = 0; i < 40; i += 1) {
  entries.push({
    type: 'expense',
    amount: 1000 + i * 100,
    category: i % 2 === 0 ? 'Maintenance' : 'Security',
    description: `Line item ${i + 1}`,
    transactionDate: new Date(
      `2026-07-${String((i % 28) + 1).padStart(2, '0')}T12:00:00+01:00`,
    ),
  });
}

entries.sort((a, b) => a.transactionDate - b.transactionDate);

const totals = calculateStatementTotals(entries);
const statement = formatStatement({
  property,
  reportingPeriod: period,
  generatedAt: new Date('2026-07-17T15:00:00+01:00'),
  entries,
  totals,
});
const summary = toStatementSummary(statement, property, period);
const pdfPath = await generateStatementPdf(statement);
const stats = fs.statSync(pdfPath);

const emptyStatement = formatStatement({
  property,
  reportingPeriod: period,
  generatedAt: new Date('2026-07-17T15:00:00+01:00'),
  entries: [],
  totals: calculateStatementTotals([]),
});
const emptyPath = await generateStatementPdf(emptyStatement);

console.log(
  JSON.stringify(
    {
      pdfPath,
      bytes: stats.size,
      emptyPath,
      statementSummary: summary,
      structure: {
        header: statement.header,
        summary: statement.summary,
        expenseBreakdown: statement.expenseBreakdown,
        transactionCount: statement.transactions.length,
        sampleTransactions: statement.transactions.slice(0, 4),
        footer: statement.footer,
      },
    },
    null,
    2,
  ),
);
