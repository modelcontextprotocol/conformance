/**
 * MRTR (SEP-2322 ephemeral) scenario helpers.
 *
 * MRTR's wire shape (resultType discriminator, requestState,
 * inputRequests) is the SEP-2322 base that SEP-2663 builds on.
 * SEP-2322 merged on 2026-05-06 with the MRTR result type renamed
 * from IncompleteResult to InputRequiredResult and the wire literal
 * flipped from "incomplete" to "input_required" (commit de6d76fb,
 * per dsp-ant request).
 *
 * Only MRTR-shaped helpers live here. SEP refs + generic check
 * scaffolding (`errMsg`, `failureCheck`, `skipCheck`) live in
 * `tasks-mrtr-helpers.ts` at the top of `scenarios/server/`.
 */

// SPEC WATCH — MRTR resultType discriminator value
// SEP-2322 merged on 2026-05-06 with the variant renamed to
// InputRequiredResult and the wire literal "input_required" (commit
// de6d76fb). SEP-2663's PR head (82fb2c4d as of 2026-05-07 PM) still
// reads "incomplete" on line 121 of the mdx — Caitie's 5/15 RC
// commitment (issue comment 4384052694) tracks the alignment to
// "input_required" both sides. This constant remains the one-line
// flip point in case the SEP-2663 follow-up surprises us.
export const MRTR_INPUT_REQUIRED_RESULT_TYPE = 'input_required';

export function isInputRequiredResult(result: any): boolean {
  if (!result) return false;
  if (result.resultType === MRTR_INPUT_REQUIRED_RESULT_TYPE) return true;
  return 'inputRequests' in result || 'requestState' in result;
}

export function isCompleteResult(result: any): boolean {
  if (!result) return false;
  if (result.resultType === 'complete') return true;
  if (!('resultType' in result)) return true;
  return !isInputRequiredResult(result);
}

/** Build an ElicitResult-shaped mock response payload. */
export function mockElicitResponse(
  content: Record<string, unknown>
): Record<string, unknown> {
  return { action: 'accept', content };
}

/** Build a CreateMessageResult-shaped mock response payload. */
export function mockSamplingResponse(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: { type: 'text', text },
    model: 'test-model',
    stopReason: 'endTurn'
  };
}

/** Build a ListRootsResult-shaped mock response payload. */
export function mockListRootsResponse(): Record<string, unknown> {
  return { roots: [{ uri: 'file:///test/root', name: 'Test Root' }] };
}
