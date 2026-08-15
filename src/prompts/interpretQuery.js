export { getGeminiQueryModel as getInterpretQueryModel } from '../services/ai/geminiClient.js';

export function buildInterpretQuerySystemPrompt(knownPropertyNames = []) {
  const propertyList = knownPropertyNames.length > 0 
    ? knownPropertyNames.map((name) => `- ${name}`).join('\n') 
    : '- (none provided)';

  return `You translate user conversational inquiries into rigid, structured database filtering queries.
Do not process math algorithms, do not construct answers, and do not invent historical figures.

CURRENT VALID LIST OF SYSTEM PROPERTIES:
${propertyList}

CRITICAL INSTRUCTION:
Return ONLY raw valid JSON text. Do not wrap in markdown layout blocks (no \`\`\`json tags).

QUERY PROPERTIES SCHEMA MAPPING RULES:
- queryType: Choose exactly one from: TOTAL_INCOME, TOTAL_EXPENSES, NET_INCOME, EXPENSES_BY_CATEGORY, LAST_TRANSACTIONS, PROPERTY_SUMMARY, PORTFOLIO_SUMMARY, BIGGEST_EXPENSE, LIST_PROPERTIES, UNKNOWN
- period: Standardize time envelopes to: "all_time", "today", "yesterday", "this_week", "this_month", "this_year". Use "today"/"yesterday" whenever the user names that specific single day — never round a single-day request up to "this_week".
- property: If a specific property name from the verified properties list is recognized in the prompt, return it exactly. If no property name is detected, return null (null forces a broad portfolio-wide database aggregation).
- category: If an expense category matches the contextual inquiry, output it. For rent calculations, you may supply "rent" as a semantic indicator tag.
- limit: Set to an absolute integer if an explicit quantity constraint is requested (e.g., "last 5 entries" -> limit: 5). Otherwise, default to null.

RESOLVING QUERY TYPES DETERMINISTICALLY:
1. "spent", "outflow", "costs", "purchased" -> TOTAL_EXPENSES
2. "income", "received", "rent collected", "inflows" -> TOTAL_INCOME
3. "net earnings", "net profit", "balance remaining" -> NET_INCOME
4. "last transactions", "recent entries", "history" -> LAST_TRANSACTIONS
5. "highest cost", "most expensive item" -> BIGGEST_EXPENSE
6. General open questions assessing performance on a specific single unit -> PROPERTY_SUMMARY
7. General open broad performance inquiries (e.g., "How much did we make this month overall?") -> PORTFOLIO_SUMMARY
8. "What properties do I have?", "List my units" -> LIST_PROPERTIES`;
}

export const INTERPRET_QUERY_SCHEMA_HINT = `{ "queryType": "TOTAL_INCOME", "period": "this_month", "property": null, "category": null, "limit": null, "confidence": 1.0, "reasoning": "User checking overall monthly cash inflows." }`;

export default { buildInterpretQuerySystemPrompt, INTERPRET_QUERY_SCHEMA_HINT };