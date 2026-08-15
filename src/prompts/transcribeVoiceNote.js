// Phase 6.4 — voice-specific edge case coverage. Transcription already
// handles West African English / Pidgin (this instruction predates Phase
// 6). What was still missing is explicit guidance for three real voice
// patterns that a spoken message hits far more often than typed text:
//   1. Mid-sentence self-correction ("paid 20k... actually make it 25k").
//   2. Multiple transactions described back-to-back in one note.
//   3. Mixed-language notes (English mixed with Yoruba/Hausa/Igbo/Pidgin
//      in the same recording).
// The fix lives here, at the audio->text step, rather than in the text
// pipeline downstream: VoiceMessageService.js already hands the transcript
// to the exact same processMessageContent pipeline used for typed text
// (see that file), so once a transcript faithfully preserves what was
// actually said, the existing multi-item detection, correction handling,
// and clarification logic already apply to it — nothing there needs to
// change. What DOES need to change is making sure the transcript itself
// never silently collapses/cleans up the very signal that logic depends
// on.
export function buildVoiceTranscriptionInstruction() {
  return 'Transcribe this West African / Nigerian English or Pidgin voice note to plain text. Return only the spoken words with no commentary, labels, or markdown. Handle common phrases like "15k" (15 thousand naira), "collect money", "pay for fuel", "transport fare", etc.\n\n'
    + 'IMPORTANT — preserve these exactly as spoken, do not clean them up or resolve them yourself:\n'
    + '1. Self-corrections: if the speaker corrects themselves mid-sentence (e.g. states one number or name then changes it, using words like "actually", "I mean", "sorry", "no wait", "make it"), transcribe the FULL correction verbatim, including both the original and corrected phrase, in the order spoken. Never silently drop the earlier value or silently keep only the corrected one — the downstream system needs to see the correction happen, not just its result.\n'
    + '2. Multiple transactions: if more than one payment, expense, or transaction is described in the note, transcribe every one of them in full, in the order spoken. Do not summarize, merge amounts together, or drop any but the first.\n'
    + '3. Mixed-language notes: if the speaker switches between English/Pidgin and another Nigerian language (e.g. Yoruba, Hausa, Igbo) within the same note, transcribe faithfully in the language(s) actually used. Render spoken amounts and numbers as numerals a downstream English-language reader can act on (e.g. write out the number even if the amount word itself was spoken in another language), but do not invent an English translation for a word or phrase you are not confident about — leave it as spoken instead. Always preserve property names and personal names exactly as spoken, in their original form.';
}

export default { buildVoiceTranscriptionInstruction };
