export const ReceiptServiceContract = Object.freeze({
  method: 'extractReceiptText',
  // `text` is null exactly when `unreadable` is true — the provider must
  // never return a guessed amount it isn't confident about (same
  // never-guess principle as the rest of the pipeline). See
  // GeminiReceiptService.js's UNREADABLE sentinel handling.
  resultShape: Object.freeze({ text: 'string|null', unreadable: 'boolean' }),
});