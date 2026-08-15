export const TranscriptionServiceContract = Object.freeze({
  method: 'transcribe',
  resultShape: Object.freeze({ text: 'string', confidence: 'number|null' }),
});