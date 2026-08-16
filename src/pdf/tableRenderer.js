const INK = '#111111';
const CHARCOAL = '#3B3B3B';
const SLATE = '#8A8A8A';
const HAIRLINE = '#DADADA';
const HAIRLINE_STRONG = '#111111';
const ZEBRA = '#FAFAFA';

export function createTableRenderer(doc, options = {}) {
  const page = {
    marginLeft: options.marginLeft ?? 40,
    marginRight: options.marginRight ?? 40,
    marginBottom: options.marginBottom ?? 60,
    topAfterPageBreak: options.topAfterPageBreak ?? 40,
  };

  const fonts = {
    regular: options.fonts?.regular ?? 'Helvetica',
    bold: options.fonts?.bold ?? 'Helvetica-Bold',
  };

  const tableWidth = options.tableWidth ?? doc.page.width - page.marginLeft - page.marginRight;

  function renderTable(config) {
    const columns = config.columns || [];
    const rows = config.rows || [];
    const headerHeight = config.headerHeight ?? 24;
    const paddingY = 8;
    const paddingX = 6;

    let y = config.startY;

    const drawHeader = () => {
      doc.save();
      doc.fillColor(SLATE).font(fonts.bold).fontSize(8);

      let x = page.marginLeft;
      for (const column of columns) {
        const textX = column.align === 'right' ? x + column.width - paddingX : x + paddingX;
        doc.text(column.label.toUpperCase(), textX, y + 8, {
          width: column.width - paddingX * 2,
          align: column.align === 'right' ? 'right' : 'left',
          lineBreak: false,
          characterSpacing: 0.6,
        });
        x += column.width;
      }
      y += headerHeight;
      doc
        .moveTo(page.marginLeft, y)
        .lineTo(page.marginLeft + tableWidth, y)
        .lineWidth(1)
        .strokeColor(HAIRLINE_STRONG)
        .stroke();
      doc.restore();
    };

    const ensureSpace = (needed) => {
      if (y + needed <= doc.page.height - page.marginBottom) {
        return;
      }
      doc.addPage();
      y = page.topAfterPageBreak;
      if (options.onNewPage) {
        options.onNewPage(doc);
      }
      drawHeader();
    };

    drawHeader();

    let isEven = false;

    for (const row of rows) {
      const cellValues = columns.map((column) =>
        String(column.format ? column.format(row) : row[column.key] ?? '—'),
      );

      let maxRowHeight = 0;
      columns.forEach((column, i) => {
        const textHeight = doc.heightOfString(cellValues[i], {
          width: column.width - paddingX * 2,
          align: column.align === 'right' ? 'right' : 'left',
        });
        if (textHeight > maxRowHeight) {
          maxRowHeight = textHeight;
        }
      });

      const dynamicRowHeight = maxRowHeight + paddingY * 2;

      ensureSpace(dynamicRowHeight);

      if (isEven) {
        doc.rect(page.marginLeft, y, tableWidth, dynamicRowHeight).fill(ZEBRA);
      }
      isEven = !isEven;

      let currentX = page.marginLeft;
      columns.forEach((column, i) => {
        const value = cellValues[i];

        if (column.key === 'amount') {
          doc.font(fonts.bold).fillColor(INK);
        } else {
          doc.font(fonts.regular).fillColor(CHARCOAL);
        }

        // `height` is set explicitly here so PDFKit can never silently
        // insert its own page break mid-row if the actual rendered height
        // ends up even a hair taller than the `heightOfString` estimate
        // above. Without a bound, PDFKit's own auto-pagination can fire
        // independently of `ensureSpace`, desyncing our locally tracked
        // `y` from PDFKit's real current page — every row after that point
        // then "lands" past the bottom margin and forces a new (empty)
        // page, cascading into a stack of blank trailing pages. Bounding
        // the height means PDFKit clips/ellipsizes instead of paginating;
        // `ensureSpace` above remains the *only* place pages get added.
        doc.text(value, currentX + paddingX, y + paddingY, {
          width: column.width - paddingX * 2,
          height: Math.max(0, doc.page.height - page.marginBottom - (y + paddingY)),
          align: column.align === 'right' ? 'right' : 'left',
          lineBreak: true,
          ellipsis: true,
        });
        currentX += column.width;
      });

      doc
        .moveTo(page.marginLeft, y + dynamicRowHeight)
        .lineTo(page.marginLeft + tableWidth, y + dynamicRowHeight)
        .lineWidth(0.5)
        .strokeColor(HAIRLINE)
        .stroke();

      y += dynamicRowHeight;
    }

    return y + 10;
  }

  return { renderTable };
}

export default {
  createTableRenderer,
};
