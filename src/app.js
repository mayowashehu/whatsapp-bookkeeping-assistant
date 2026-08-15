import express from 'express';
import { requestLogger } from './middleware/requestLogger.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { errorHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

/**
 * Express application factory.
 * Configures middleware and routes only — does not start listening.
 * Separated from server.js so the app can be imported in tests later.
 */
const app = express();

// UNIFIED PARSER: Capture raw body for signature verification while parsing JSON cleanly once.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (buf && buf.length) {
        req.rawBody = buf;
      }
    },
  })
);

app.use(express.urlencoded({ extended: true }));

app.use(requestLogger);
app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;