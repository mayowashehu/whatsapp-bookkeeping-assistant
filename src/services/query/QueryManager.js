import { AI_BUSY_FALLBACK_MESSAGE } from '../../ai/aiFallback.js';
import { interpretQuery, resolveScopeAnswerAsync, QUERY_TYPES } from './QueryInterpreter.js';
import { QUERY_PERIODS } from './queryPeriod.js';
import * as QueryFormatter from './QueryFormatter.js';
import * as defaultRepository from './QueryRepository.js';
import PendingQuery from '../../models/pendingQuery.js';

export function createQueryManager(deps = {}) {
  const QueryRepository = deps.repository || defaultRepository;
  const PendingQueryModel = deps.pendingQueryModel || PendingQuery;

  async function handleQuery({ text, knownProperties, aiService, referenceDate, senderId }) {
    // A senderId doubles as the WhatsApp number throughout this pipeline
    // (see messageHandlerShared.processMessageContent), so it's a safe
    // per-sender key for pending scope state, same as PendingStatement.
    const fromNumber = senderId;

    if (fromNumber) {
      const pending = await PendingQueryModel.findOne({ fromNumber: String(fromNumber) });
      if (pending) {
        const scopeAnswer = await resolveScopeAnswerAsync(text, {
          knownProperties: knownProperties || [],
          referenceDate: referenceDate || new Date(),
          aiService,
        });

        if (scopeAnswer.aiUnavailable) {
          return { replyText: AI_BUSY_FALLBACK_MESSAGE, request: { queryType: pending.queryType }, result: null };
        }

        if (scopeAnswer.unmatchedProperty) {
          return {
            replyText: QueryFormatter.formatUnmatchedProperty(scopeAnswer.unmatchedProperty),
            request: { queryType: pending.queryType },
            result: null,
          };
        }

        if (!scopeAnswer.period && !scopeAnswer.property && !scopeAnswer.month) {
          // Still nothing to scope to, even after the AI attempt — ask
          // again rather than silently defaulting or dropping the
          // original question.
          return {
            replyText: QueryFormatter.formatScopeClarification(),
            request: { queryType: pending.queryType, needsScopeClarification: true },
            result: null,
          };
        }

        await PendingQueryModel.deleteOne({ fromNumber: String(fromNumber) });

        const request = {
          queryType: pending.queryType,
          period: scopeAnswer.month ? null : (scopeAnswer.period || QUERY_PERIODS.THIS_MONTH),
          month: scopeAnswer.month || null,
          year: scopeAnswer.year || null,
          property: scopeAnswer.property || null,
          category: pending.category || null,
          limit: null,
          confidence: 1,
          reasoning: 'Resolved from scope clarification follow-up.',
          source: scopeAnswer.source || 'scope_followup',
        };

        const result = await QueryRepository.executeQuery(request, senderId);
        return { replyText: QueryFormatter.formatQueryResult(result), request, result };
      }
    }

    const request = await interpretQuery(text, { knownProperties, aiService, referenceDate, senderId });

    if (request.aiUnavailable) {
      return { replyText: AI_BUSY_FALLBACK_MESSAGE, request, result: null };
    }

    if (request.needsScopeClarification) {
      if (fromNumber && request.pendingQueryType) {
        await PendingQueryModel.findOneAndUpdate(
          { fromNumber: String(fromNumber) },
          {
            senderId,
            queryType: request.pendingQueryType,
            category: request.pendingCategory || null,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          },
          { upsert: true, new: true },
        );
      }
      return {
        replyText: QueryFormatter.formatScopeClarification(),
        request,
        result: null,
      };
    }

    if (request.queryType === QUERY_TYPES.UNKNOWN) {
      return { replyText: QueryFormatter.formatUnknownQuery(), request, result: null };
    }

    if (request.unmatchedProperty) {
      return { replyText: QueryFormatter.formatUnmatchedProperty(request.unmatchedProperty), request, result: null };
    }

    const result = await QueryRepository.executeQuery(request, senderId);
    return { replyText: QueryFormatter.formatQueryResult(result), request, result };
  }

  return { handleQuery };
}

const defaultManager = createQueryManager();
export const handleQuery = defaultManager.handleQuery;
export default { createQueryManager, handleQuery };