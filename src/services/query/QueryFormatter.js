import { formatNaira } from '../../utils/currencyFormatter.js';
import { MAX_TRANSACTIONS_LIMIT } from './QueryInterpreter.js';

export function formatQueryResult(result) {
  if (!result || result.kind === 'unknown') {
    return formatUnknownQuery();
  }

  if (result.kind === 'list_properties') {
    const { properties } = result;
    if (!properties || properties.length === 0) {
      return '🏢 *Your Properties*\n\nNo active properties yet.\n\n_Add a property by logging your first transaction._';
    }
    const lines = ['🏢 *Your Active Properties*', ''];
    for (const prop of properties) {
      let line = `- *${prop.name}*`;
      if (prop.aliases && prop.aliases.length > 0) {
        line += ` _(Aliases: ${prop.aliases.join(', ')})_`;
      }
      lines.push(line);
    }
    lines.push('');
    lines.push('_Log entries or request statements using any of these names._');
    return lines.join('\n');
  }

  const periodLabel = result.periodBounds?.label || 'all time';
  const propertyName = result.request?.property?.name || null;
  const category = result.request?.category || null;
  const scope = formatScopeLine(periodLabel, propertyName);

  switch (result.kind) {
    case 'total': {
      if (!result.total) return noRecordsMessage({ type: result.type, periodLabel, propertyName, category });

      const isRent = result.request?.category === 'rent' && result.type === 'income';
      const verb = result.type === 'income' ? (isRent ? 'collected' : 'brought in') : 'spent';
      const topicPhrase = isRent ? ' in rent' : '';
      const periodPhrase =
        periodLabel && periodLabel !== 'all time'
          ? periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)
          : 'Overall';
      const scopePhrase = propertyName
        ? ` for ${propertyName}`
        : result.propertyCount > 1
          ? ` across ${result.propertyCount} properties`
          : '';

      return [
        `💰 *Total ${capitalize(result.type)}*`,
        '',
        `${periodPhrase}, you ${verb} ${formatNaira(result.total)}${topicPhrase}${scopePhrase}.`,
        scope,
      ].join('\n');
    }

    case 'net':
      if (!result.income && !result.expenses) return noRecordsMessage({ type: 'records', periodLabel, propertyName });
      return [
        '📊 *Net Income Report*',
        '',
        `- *Net:* ${formatNaira(result.net)}`,
        `- *Total Income:* ${formatNaira(result.income)}`,
        `- *Total Expenses:* ${formatNaira(result.expenses)}`,
        scope,
      ].join('\n');

    case 'expenses_by_category':
      if (!result.rows?.length) return noRecordsMessage({ type: 'expenses', periodLabel, propertyName, category });
      if (category && result.rows.length === 1) {
        return [
          '📑 *Expense Breakdown*',
          '',
          `- *Category:* ${capitalize(result.rows[0].category)}`,
          `- *Total:* ${formatNaira(result.rows[0].total)}`,
          scope,
        ].join('\n');
      }
      return [
        '📑 *Expenses by Category*',
        '',
        ...result.rows.map((row) => `- *${capitalize(row.category)}:* ${formatNaira(row.total)}`),
        scope,
      ].join('\n');

    case 'last_transactions': {
      if (!result.rows?.length) return noRecordsMessage({ type: 'transactions', periodLabel, propertyName });
      // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): the header
      // always said "Last N Transactions" using rows.length, which was
      // actively misleading once "all" started actually being honored
      // (see QueryInterpreter's showAll) — "Last 12 Transactions" reads as
      // "the 12 most recent," not "all 12 that exist." Header now reflects
      // which one it actually is, and a plain (non-"all") request gets a
      // one-line hint that "all" is available instead of just silently
      // capping at the default with no way to know more exist.
      const showAll = Boolean(result.request?.showAll);
      const hitCap = showAll && result.rows.length >= MAX_TRANSACTIONS_LIMIT;
      const header = hitCap
        ? `📊 *Most Recent ${result.rows.length} Transactions* (capped — ask for a narrower date range to see more)`
        : showAll
          ? `📊 *All ${result.rows.length} Transaction${result.rows.length === 1 ? '' : 's'}*`
          : `📊 *Last ${result.rows.length} Transaction${result.rows.length === 1 ? '' : 's'}*`;
      const hint = showAll ? '' : "\n\n_Reply \"show all\" to see every transaction for this period, not just the most recent._";
      return [
        header,
        '',
        ...result.rows.map((row, index) => {
          const label = row.type === 'income' ? 'Income' : capitalize(row.category || 'Expense');
          return `${index + 1}. *${formatNaira(row.amount)}* — ${label}\n   - ${row.property?.name || 'Unknown'} · ${formatDate(row.transactionDate)}`;
        }),
        scope + hint,
      ].join('\n');
    }

    case 'flagged_transactions':
      if (!result.rows?.length) {
        return [
          '🚩 *No Flagged Transactions*',
          '',
          'Nothing is currently flagged for review.',
        ].join('\n');
      }
      return [
        `🚩 *${result.rows.length} Flagged Transaction${result.rows.length === 1 ? '' : 's'}*`,
        '',
        ...result.rows.map((row, index) => {
          const label = row.type === 'income' ? 'Income' : capitalize(row.category || 'Expense');
          const note = row.flagNote ? `\n   - Note: ${row.flagNote}` : '';
          return `${index + 1}. *${formatNaira(row.amount)}* — ${label}\n   - ${row.property?.name || 'Unknown'} · ${formatDate(row.transactionDate)}${note}`;
        }),
        scope,
        '',
        '_Say "edit the [amount] [property] transaction" to fix one, or "clear the flag on ..." once it checks out._',
      ].join('\n');

    case 'portfolio_summary':
    case 'property_summary': {
      if (!result.income && !result.expenses) {
        if (result.kind === 'portfolio_summary') {
          return noRecordsMessage({ type: 'records', periodLabel, propertyName: null });
        }
        return noRecordsMessage({ type: 'records', periodLabel, propertyName: propertyName || 'that property' });
      }
      const title = result.kind === 'portfolio_summary'
        ? '📊 *Portfolio Summary*'
        : `🏢 *${propertyName || 'Property'} Summary*`;
      return [
        title,
        '',
        `- *Total Income:* ${formatNaira(result.income)}`,
        `- *Total Expenses:* ${formatNaira(result.expenses)}`,
        `- *Net:* ${formatNaira(result.net)}`,
        scope,
      ].join('\n');
    }

    case 'biggest_expense':
      if (!result.entry) return noRecordsMessage({ type: 'expenses', periodLabel, propertyName });
      return [
        '💰 *Biggest Expense*',
        '',
        `- *Amount:* ${formatNaira(result.entry.amount)}`,
        `- *Category:* ${capitalize(result.entry.category || 'expense')}`,
        `- *Property:* ${result.entry.property?.name || propertyName || 'Unknown'}`,
        scope,
      ].join('\n');

    default:
      return '⚠️ No records found.';
  }
}

export function formatUnmatchedProperty(name) {
  return [
    '⚠️ *Property Not Found*',
    '',
    `No records found for *${name}*.`,
    '',
    '_Check the spelling or ask to list your properties._',
  ].join('\n');
}

export function formatScopeClarification() {
  return "Do you want this for this month, this year, or for a specific property?";
}

export function formatUnknownQuery() {
  return [
    '⚠️ *Could Not Understand*',
    '',
    'Try asking about:',
    '- Total income or expenses',
    '- Net income for a period',
    '- Last transactions',
    '- Flagged transactions awaiting review',
    '- Property or portfolio summary',
  ].join('\n');
}

const NO_RESULTS_NOUN = Object.freeze({
  income: 'income',
  expense: 'expenses',
  expenses: 'expenses',
  records: 'records',
  transactions: 'transactions',
});

function noRecordsMessage({ type, periodLabel, propertyName, category }) {
  const scopeParts = [];
  if (propertyName) scopeParts.push(`for *${propertyName}*`);
  if (periodLabel && periodLabel !== 'all time') scopeParts.push(periodLabel);
  const scopeStr = scopeParts.length ? ` ${scopeParts.join(' · ')}` : '';

  const noun = NO_RESULTS_NOUN[type] || type || 'records';

  if (category) {
    return `📊 *No Results*\n\nNo *${category}* ${noun} found${scopeStr}.`;
  }
  return `📊 *No Results*\n\nNo ${noun} found${scopeStr}.`;
}

function formatScopeLine(periodLabel, propertyName) {
  const parts = [];
  if (propertyName) parts.push(`*Property:* ${propertyName}`);
  if (periodLabel && periodLabel !== 'all time') parts.push(`*Period:* ${periodLabel}`);
  if (!parts.length) return '';
  return `\n_${parts.join(' · ')}_`;
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export default { formatQueryResult, formatUnmatchedProperty, formatUnknownQuery, formatScopeClarification };
