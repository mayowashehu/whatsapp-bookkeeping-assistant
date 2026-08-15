import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoiceTranscriptionInstruction } from '../../prompts/transcribeVoiceNote.js';
import { createVoiceMessageHandler } from '../../whatsapp/services/VoiceMessageService.js';

// --- Transcription prompt: preserves the three voice-specific signals ---

test('voice transcription instruction tells the model to preserve mid-sentence self-corrections verbatim', () => {
  const instruction = buildVoiceTranscriptionInstruction();
  assert.match(instruction, /self-correction/i);
  assert.match(instruction, /actually/i);
  assert.match(instruction, /verbatim/i);
});

test('voice transcription instruction tells the model to preserve every transaction in a multi-item note', () => {
  const instruction = buildVoiceTranscriptionInstruction();
  assert.match(instruction, /multiple transactions/i);
  assert.match(instruction, /do not summarize/i);
});

test('voice transcription instruction gives explicit guidance for mixed-language notes', () => {
  const instruction = buildVoiceTranscriptionInstruction();
  assert.match(instruction, /mixed-language/i);
  assert.match(instruction, /Yoruba/i);
});

test('voice transcription instruction still carries the pre-existing Pidgin/West African English guidance (no regression)', () => {
  const instruction = buildVoiceTranscriptionInstruction();
  assert.match(instruction, /Pidgin/i);
  assert.match(instruction, /15k/);
});

// --- VoiceMessageService.js: full, unmodified transcript reaches the text pipeline ---

function buildHandlerWithTranscript(transcribedText, overrides = {}) {
  const calls = { processMessageContent: [] };

  const handler = createVoiceMessageHandler({
    downloadWhatsAppMedia: async () => ({ filePath: '/tmp/fake.ogg', mimeType: 'audio/ogg' }),
    deleteTempAudioFile: async () => {},
    createTranscriptionService: () => ({
      transcribe: async () => ({ text: transcribedText, confidence: null }),
    }),
    checkFastPassIntent: () => ({ isFastPass: false }),
    processMessageContent: async (args) => {
      calls.processMessageContent.push(args);
      return { replyText: 'ok' };
    },
    sendWhatsAppText: async () => ({ success: true }),
    logInternalError: () => {},
    logProcessingEvent: () => {},
    ...overrides,
  });

  return { handler, calls };
}

test('a self-correction transcript is handed to processMessageContent completely unmodified', async () => {
  const transcript = 'Paid 20k for diesel, actually make it 25k, at Orchid';
  const { handler, calls } = buildHandlerWithTranscript(transcript);

  await handler.handleVoiceMessage({ audio: { id: 'media-1' }, messageId: 'm1', senderId: '2348011111111' });

  assert.equal(calls.processMessageContent.length, 1);
  assert.equal(calls.processMessageContent[0].content, transcript);
});

test('a multi-transaction transcript is handed to processMessageContent completely unmodified (not split or truncated)', async () => {
  const transcript = 'Received 100k rent for Flat 2, and paid 20k for repairs at Orchid, and paid 5k for diesel at Flat 2';
  const { handler, calls } = buildHandlerWithTranscript(transcript);

  await handler.handleVoiceMessage({ audio: { id: 'media-2' }, messageId: 'm2', senderId: '2348022222222' });

  assert.equal(calls.processMessageContent[0].content, transcript);
});

test('a long transcript is passed to processMessageContent in full even though the user-facing "I heard" preview is truncated', async () => {
  const longTranscript = 'Paid 5k for diesel at Orchid. '.repeat(20).trim();
  const { handler, calls } = buildHandlerWithTranscript(longTranscript);

  const sent = [];
  const { handler: handler2 } = buildHandlerWithTranscript(longTranscript, {
    sendWhatsAppText: async (to, text) => {
      sent.push(text);
      return { success: true };
    },
  });

  await handler2.handleVoiceMessage({ audio: { id: 'media-3' }, messageId: 'm3', senderId: '2348033333333' });

  // The reply preview is truncated for readability...
  assert.ok(sent[0].length < longTranscript.length + 100);
  // ...but processMessageContent itself must have received the whole thing.
  await handler.handleVoiceMessage({ audio: { id: 'media-4' }, messageId: 'm4', senderId: '2348044444444' });
  assert.equal(calls.processMessageContent[0].content, longTranscript);
});
