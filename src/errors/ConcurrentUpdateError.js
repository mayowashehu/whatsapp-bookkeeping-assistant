export class ConcurrentUpdateError extends Error {
  constructor(message = 'A concurrent update was detected.') {
    super(message);
    this.name = 'ConcurrentUpdateError';
    
    // Maintains proper stack trace for V8 engines
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConcurrentUpdateError);
    }
  }
}