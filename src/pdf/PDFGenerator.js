import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { createTableRenderer } from './tableRenderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Embedded Unicode fonts (Liberation Sans — metric-compatible with Helvetica,
// but unlike the PDF standard 14 fonts it actually contains the ₦ glyph).
// Using the standard "Helvetica" font with a ₦ character silently falls back
// to a missing-glyph box, which is what was showing as a garbled symbol next
// to every amount in the report.
const FONT_REGULAR = path.join(__dirname, 'fonts', 'LiberationSans-Regular.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf');

const FONT = 'Body';
const FONT_B = 'Body-Bold';

// --- Layout ---------------------------------------------------------------
const PAGE_MARGIN_X = 50;
const CONTENT_TOP_CONTINUED = 58;
const MARGIN_BOTTOM = 68;
const HEADER_HEIGHT = 108;

// --- Palette (monochrome / premium) ---------------------------------------
const INK = '#111111'; // primary text
const CHARCOAL = '#3B3B3B'; // secondary text
const SLATE = '#8A8A8A'; // muted labels
const HAIRLINE = '#DADADA'; // dividers
const HAIRLINE_STRONG = '#111111';

export async function generateStatementPdf(statement) {
  const filename = `statement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  const pdfPath = path.join(os.tmpdir(), filename);

  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    autoFirstPage: true,
    margins: { top: 0, bottom: MARGIN_BOTTOM, left: PAGE_MARGIN_X, right: PAGE_MARGIN_X },
    info: {
      Title: `${statement.header.propertyName} Statement — ${statement.header.brandName}`,
      Author: statement.header.brandName,
    },
  });

  doc.registerFont(FONT, FONT_REGULAR);
  doc.registerFont(FONT_B, FONT_BOLD);

  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  let y = renderExecutiveHeader(doc, statement);
  y = renderKPISummary(doc, statement, y);
  y = renderExpenseBreakdown(doc, statement, y);
  renderTransactionTable(doc, statement, y);
  renderFooter(doc, statement);

  doc.end();

  try {
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      doc.on('error', reject);
    });
  } catch (err) {
    try {
      fs.unlinkSync(pdfPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  return pdfPath;
}

function contentWidth(doc) {
  return doc.page.width - PAGE_MARGIN_X * 2;
}

/**
 * Every block must check available space itself and BEFORE drawing any text,
 * rather than letting pdfkit's own auto-pagination decide mid-draw. Mixing
 * pdfkit's implicit page breaks with our own manual y-tracking is what was
 * producing the blank/near-empty trailing pages — once our locally tracked
 * `y` fell out of sync with pdfkit's actual current page, every subsequent
 * block kept "landing" past the bottom margin and silently forcing new
 * pages. Routing every section through this single helper keeps the two in
 * sync at all times.
 */
function ensureSpace(doc, y, needed, { onNewPage } = {}) {
  if (y + needed <= doc.page.height - MARGIN_BOTTOM) {
    return y;
  }
  doc.addPage();
  const startY = onNewPage ? onNewPage(doc) : CONTENT_TOP_CONTINUED;
  return startY;
}

function trackedText(doc, text, x, y, opts = {}) {
  doc.text(text, x, y, { characterSpacing: 1.1, ...opts });
}

/**
 * Remaining vertical space on the current page before the bottom margin,
 * from a given y. Pass this as the `height` option on any `.text()` call
 * that could conceivably wrap — it stops PDFKit from silently paginating
 * on its own if our pre-measured estimate ever comes out a hair short of
 * the real rendered height. See the matching note in tableRenderer.js for
 * why that silent auto-pagination is what produces trailing blank pages.
 */
function remainingHeight(doc, y) {
  return Math.max(0, doc.page.height - MARGIN_BOTTOM - y);
}

// --- Header -----------------------------------------------------------------

function renderExecutiveHeader(doc, statement) {
  doc.rect(0, 0, doc.page.width, HEADER_HEIGHT).fill(INK);

  doc
    .fillColor('#FFFFFF')
    .font(FONT_B)
    .fontSize(15)
    .text(statement.header.brandName, PAGE_MARGIN_X, 34, {
      characterSpacing: 0.6,
      width: contentWidth(doc),
      height: remainingHeight(doc, 34),
      ellipsis: true,
    });

  doc
    .fillColor('#B7B7B7')
    .font(FONT)
    .fontSize(10)
    .text(
      `${statement.header.propertyName}   |   ${statement.header.reportingPeriod}`,
      PAGE_MARGIN_X,
      60,
      { width: contentWidth(doc), height: remainingHeight(doc, 60), ellipsis: true },
    );

  let y = HEADER_HEIGHT + 22;

  doc
    .fillColor(SLATE)
    .font(FONT)
    .fontSize(8.5)
    .text(
      `GENERATED ${statement.header.generatedAt.toUpperCase()}   ·   CURRENCY ${statement.header.currency}`,
      PAGE_MARGIN_X,
      y,
      { characterSpacing: 0.4, width: contentWidth(doc), height: remainingHeight(doc, y), ellipsis: true },
    );

  y += 26;
  doc.moveTo(PAGE_MARGIN_X, y).lineTo(doc.page.width - PAGE_MARGIN_X, y).lineWidth(1).strokeColor(HAIRLINE).stroke();

  return y + 24;
}

// --- Financial summary -------------------------------------------------------

function renderKPISummary(doc, statement, startY) {
  const summary = statement.summary;
  const blockHeight = 84;

  let y = ensureSpace(doc, startY, 20 + blockHeight);

  doc.fillColor(INK).font(FONT_B).fontSize(9);
  trackedText(doc, 'FINANCIAL SUMMARY', PAGE_MARGIN_X, y);
  y += 20;

  const width = contentWidth(doc);
  const colWidth = width / 3;

  doc.moveTo(PAGE_MARGIN_X, y).lineTo(PAGE_MARGIN_X + width, y).lineWidth(1).strokeColor(HAIRLINE_STRONG).stroke();

  const cells = [
    { label: 'TOTAL INCOME', value: summary.totalIncomeFormatted, big: false },
    { label: 'TOTAL EXPENSES', value: summary.totalExpensesFormatted, big: false },
    {
      label: 'NET INCOME',
      value: summary.isProfitable
        ? summary.netIncomeFormatted
        : `(${summary.netIncomeFormatted.replace('-', '')})`,
      big: true,
    },
  ];

  const labelY = y + 16;
  const valueY = y + 32;
  const cellBottom = y + blockHeight;

  cells.forEach((cell, i) => {
    const x = PAGE_MARGIN_X + colWidth * i;

    if (i > 0) {
      doc.moveTo(x, y).lineTo(x, cellBottom).lineWidth(0.75).strokeColor(HAIRLINE).stroke();
    }

    const innerX = x + (i === 0 ? 0 : 20);
    const innerWidth = colWidth - 20;

    doc.fillColor(SLATE).font(FONT_B).fontSize(7.5);
    trackedText(doc, cell.label, innerX, labelY, { width: innerWidth, height: remainingHeight(doc, labelY), ellipsis: true });

    doc
      .fillColor(INK)
      .font(FONT_B)
      .fontSize(cell.big ? 18 : 15)
      .text(cell.value, innerX, valueY, { width: innerWidth, height: remainingHeight(doc, valueY), ellipsis: true });
  });

  doc
    .moveTo(PAGE_MARGIN_X, cellBottom)
    .lineTo(PAGE_MARGIN_X + width, cellBottom)
    .lineWidth(1)
    .strokeColor(HAIRLINE_STRONG)
    .stroke();

  return cellBottom + 30;
}

// --- Expense breakdown --------------------------------------------------------

function renderExpenseBreakdown(doc, statement, startY) {
  const breakdown = statement.expenseBreakdown || [];
  const width = contentWidth(doc);
  const rowHeight = 22;

  let y = ensureSpace(doc, startY, 20 + rowHeight);

  doc.fillColor(INK).font(FONT_B).fontSize(9);
  trackedText(doc, 'EXPENSE BREAKDOWN', PAGE_MARGIN_X, y);
  y += 20;

  if (breakdown.length === 0) {
    doc
      .fillColor(SLATE)
      .font(FONT)
      .fontSize(10)
      .text('No expenses recorded.', PAGE_MARGIN_X, y, { width, height: remainingHeight(doc, y), ellipsis: true });
    return y + 30;
  }

  const amountColWidth = 130;
  const labelWidth = width - amountColWidth - 16;

  for (const row of breakdown) {
    y = ensureSpace(doc, y, rowHeight, {
      onNewPage: (d) => {
        d.fillColor(SLATE).font(FONT).fontSize(8);
        trackedText(d, 'EXPENSE BREAKDOWN (CONTINUED)', PAGE_MARGIN_X, CONTENT_TOP_CONTINUED);
        return CONTENT_TOP_CONTINUED + 22;
      },
    });

    const labelBaseline = y + 6;

    doc
      .fillColor(CHARCOAL)
      .font(FONT)
      .fontSize(10)
      .text(row.category, PAGE_MARGIN_X, labelBaseline, {
        width: labelWidth,
        ellipsis: true,
        lineBreak: false,
      });

    const labelTextWidth = Math.min(doc.widthOfString(row.category), labelWidth);

    doc
      .fillColor(INK)
      .font(FONT_B)
      .fontSize(10)
      .text(row.totalFormatted, PAGE_MARGIN_X + width - amountColWidth, labelBaseline, {
        width: amountColWidth,
        align: 'right',
        height: remainingHeight(doc, labelBaseline),
        lineBreak: false,
      });

    const amountTextWidth = doc.widthOfString(row.totalFormatted);
    const leaderStart = PAGE_MARGIN_X + labelTextWidth + 8;
    const leaderEnd = PAGE_MARGIN_X + width - amountColWidth + (amountColWidth - amountTextWidth) - 8;

    if (leaderEnd - leaderStart > 6) {
      doc
        .save()
        .dash(1, { space: 2 })
        .moveTo(leaderStart, labelBaseline + 5)
        .lineTo(leaderEnd, labelBaseline + 5)
        .lineWidth(0.75)
        .strokeColor(HAIRLINE)
        .stroke()
        .undash()
        .restore();
    }

    y += rowHeight;
  }

  doc.moveTo(PAGE_MARGIN_X, y).lineTo(PAGE_MARGIN_X + width, y).lineWidth(1).strokeColor(HAIRLINE_STRONG).stroke();
  y += 8;

  doc.fillColor(INK).font(FONT_B).fontSize(10).text('TOTAL EXPENSES', PAGE_MARGIN_X, y, { lineBreak: false });
  doc
    .fillColor(INK)
    .font(FONT_B)
    .fontSize(10)
    .text(statement.summary.totalExpensesFormatted, PAGE_MARGIN_X + width - amountColWidth, y, {
      width: amountColWidth,
      align: 'right',
      lineBreak: false,
    });

  return y + 34;
}

// --- Transaction ledger --------------------------------------------------------

function renderTransactionTable(doc, statement, startY) {
  const transactions = statement.transactions || [];
  const width = contentWidth(doc);

  let y = ensureSpace(doc, startY, 40);

  doc.fillColor(INK).font(FONT_B).fontSize(9);
  trackedText(doc, 'TRANSACTION LEDGER', PAGE_MARGIN_X, y);
  y += 20;

  if (transactions.length === 0) {
    doc
      .fillColor(SLATE)
      .font(FONT)
      .fontSize(10)
      .text('No transactions in this period.', PAGE_MARGIN_X, y, { width, height: remainingHeight(doc, y), ellipsis: true });
    return;
  }

  const columns = [
    { key: 'date', label: 'Date', width: width * 0.14, align: 'left' },
    { key: 'category', label: 'Category', width: width * 0.19, align: 'left' },
    { key: 'description', label: 'Description', width: width * 0.4, align: 'left' },
    {
      key: 'amount',
      label: 'Amount',
      width: width * 0.27,
      align: 'right',
      // The row's raw `amount` field has no currency symbol or thousands
      // separators — always render the pre-formatted string instead, with a
      // +/- prefix standing in for the income/expense color coding so the
      // report stays strictly monochrome.
      format: (row) => `${row.typeRaw === 'income' ? '+' : '\u2013'}${row.amountFormatted}`,
    },
  ];

  const table = createTableRenderer(doc, {
    marginLeft: PAGE_MARGIN_X,
    marginRight: PAGE_MARGIN_X,
    marginBottom: MARGIN_BOTTOM,
    topAfterPageBreak: CONTENT_TOP_CONTINUED + 22,
    tableWidth: width,
    fonts: { regular: FONT, bold: FONT_B },
    onNewPage: (d) => {
      d.fillColor(SLATE).font(FONT).fontSize(8);
      trackedText(d, 'TRANSACTION LEDGER (CONTINUED)', PAGE_MARGIN_X, CONTENT_TOP_CONTINUED);
    },
  });

  table.renderTable({
    columns,
    rows: transactions,
    startY: y,
    rowHeight: 22,
    headerHeight: 24,
  });
}

// --- Footer ----------------------------------------------------------------

function renderFooter(doc, statement) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - 34;

    doc
      .moveTo(PAGE_MARGIN_X, y - 12)
      .lineTo(doc.page.width - PAGE_MARGIN_X, y - 12)
      .strokeColor(HAIRLINE)
      .lineWidth(0.75)
      .stroke();

    doc
      .fillColor(SLATE)
      .font(FONT)
      .fontSize(8)
      .text(statement.footer.text.toUpperCase(), PAGE_MARGIN_X, y, {
        width: contentWidth(doc) * 0.7,
        align: 'left',
        characterSpacing: 0.3,
        // Footer sits only ~34pt above the physical page edge — deep inside
        // the bottom margin PDFKit itself would normally refuse to draw
        // into. If this text ever wrapped to a second line here, PDFKit's
        // own pagination would silently insert a brand-new (empty) page
        // right in the middle of this loop. lineBreak:false plus a tight
        // height bound guarantees it never wraps, so it never can.
        lineBreak: false,
        height: doc.page.height - y,
        ellipsis: true,
      });

    doc.text(`PAGE ${i + 1} OF ${range.count}`, PAGE_MARGIN_X, y, {
      width: contentWidth(doc),
      align: 'right',
      characterSpacing: 0.3,
      lineBreak: false,
      height: doc.page.height - y,
    });
  }
}

export default {
  generateStatementPdf,
};
