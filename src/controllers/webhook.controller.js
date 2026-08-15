import { verifyWebhookChallenge } from '../whatsapp/services/webhookVerification.service.js';
import { receiveWebhook } from '../whatsapp/services/webhookReceive.service.js';

export function verifyWebhook(req, res, next) {
  try {
    const challenge = verifyWebhookChallenge({
      mode: req.query['hub.mode'],
      token: req.query['hub.verify_token'],
      challenge: req.query['hub.challenge'],
    });

    res.status(200).send(challenge);
  } catch (err) {
    next(err);
  }
}

export function receiveWebhookMessage(req, res) {
  // Acknowledge receipt to Meta immediately (200 OK) to prevent webhook retries/timeouts
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || !Array.isArray(body.entry)) {
      console.error(
        '[WhatsAppWebhook] Malformed payload: missing or invalid `entry` array.',
        { receivedType: typeof body, keys: body && typeof body === 'object' ? Object.keys(body) : null },
      );
      return;
    }

    // Process ALL entries, changes, and individual messages in the batched payload asynchronously
    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes)) {
        console.error(
          '[WhatsAppWebhook] Malformed payload: entry missing `changes` array.',
          { entryId: entry?.id ?? null },
        );
        continue;
      }

      for (const change of entry.changes) {
        const value = change?.value;
        if (!value) {
          console.error(
            '[WhatsAppWebhook] Malformed payload: change missing `value` object.',
            { entryId: entry?.id ?? null, field: change?.field ?? null },
          );
          continue;
        }

        // Construct a single-message payload wrapper for each message received in the batch
        if (Array.isArray(value.messages) && value.messages.length > 0) {
          for (const message of value.messages) {
            const singleMessagePayload = {
              object: body.object || 'whatsapp_business_account',
              entry: [
                {
                  id: entry.id,
                  changes: [
                    {
                      field: change.field || 'messages',
                      value: {
                        messaging_product: value.messaging_product,
                        metadata: value.metadata,
                        contacts: value.contacts,
                        messages: [message],
                        statuses: value.statuses,
                      },
                    },
                  ],
                },
              ],
            };

            receiveWebhook(singleMessagePayload)
          }
        }
      }
    }
  } catch (err) {
    console.error('[FATAL] Inbound webhook extraction and dispatch failed:', err);
  }
}