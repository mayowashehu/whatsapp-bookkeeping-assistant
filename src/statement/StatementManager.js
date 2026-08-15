import { calculateStatementTotals } from './StatementCalculator.js';
import { formatStatement, toStatementSummary } from './StatementFormatter.js';
import * as defaultRepository from './StatementRepository.js';
import { resolveCalendarMonthBounds } from './statementPeriod.js';
import { generateStatementPdf } from '../pdf/PDFGenerator.js';
import { deleteTempPdfFile } from '../pdf/tempPdf.js';

/**
 * StatementManager — orchestrates statement generation only.
 * Does not send WhatsApp documents.
 * If generation fails after a PDF path exists, the temp file is deleted.
 *
 * @param {{ repository?: typeof defaultRepository, generatePdf?: Function }} [deps]
 */
export function createStatementManager(deps = {}) {
  const StatementRepository = deps.repository || defaultRepository;
  const generatePdf = deps.generatePdf || generateStatementPdf;

  /**
   * @param {{ propertyId: string, year: number, month: number, senderId: string }} input
   * @returns {Promise<{ pdfPath: string, statementSummary: object, statement: object }>}
   */
  async function generateMonthlyStatement({ propertyId, year, month, senderId }) {
    if (!propertyId) {
      throw new Error('propertyId is required');
    }
    if (!senderId) {
      throw new Error('senderId is required');
    }

    let pdfPath = null;

    try {
      const reportingPeriod = resolveCalendarMonthBounds(year, month);
      const property = await StatementRepository.findPropertyById(propertyId, senderId);

      if (!property) {
        throw new Error(`Property not found: ${propertyId}`);
      }

      const entries = await StatementRepository.findConfirmedEntriesForPeriod({
        propertyId,
        startDate: reportingPeriod.startDate,
        endDate: reportingPeriod.endDate,
        senderId,
      });

      const totals = calculateStatementTotals(entries);
      const statement = formatStatement({
        property,
        reportingPeriod,
        generatedAt: new Date(),
        entries,
        totals,
      });

      pdfPath = await generatePdf(statement);
      const statementSummary = toStatementSummary(statement, property, reportingPeriod);

      return {
        pdfPath,
        statementSummary,
        statement,
      };
    } catch (err) {
      if (pdfPath) {
        await deleteTempPdfFile(pdfPath);
      }
      throw err;
    }
  }

  return {
    generateMonthlyStatement,
  };
}

const defaultManager = createStatementManager();

export const generateMonthlyStatement = defaultManager.generateMonthlyStatement;

export default {
  createStatementManager,
  generateMonthlyStatement,
};
