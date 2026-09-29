import { z } from 'zod';

/**
 * Guest email verification (ADR-0020, task P5-4).
 *
 * A guest proves they can read an address before it becomes their ticket-cap
 * key. Nothing here ever returns the code, and no response distinguishes
 * "no such code" from "wrong code": the caller learns only whether they are
 * verified.
 */

export const RequestVerificationCodeRequestSchema = z.strictObject({
  email: z.email().max(254),
});
export type RequestVerificationCodeRequest = z.infer<typeof RequestVerificationCodeRequestSchema>;

export const VerifyEmailRequestSchema = z.strictObject({
  email: z.email().max(254),
  // Accepted loosely and normalized server-side, so a code pasted with a space
  // or a dash is not a failed attempt against the limit.
  code: z.string().min(6).max(16),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

/**
 * What a guest may know about their own verification state.
 *
 * Deliberately thin: the address they verified and when it stops counting.
 * No identifiers, no attempt counts, nothing that helps someone guessing.
 */
export const GuestVerificationSchema = z.object({
  email: z.email().nullable(),
  verified: z.boolean(),
  /** When the verification stops being usable, if there is one. */
  expiresAt: z.iso.datetime().nullable(),
  serverTime: z.iso.datetime(),
});
export type GuestVerification = z.infer<typeof GuestVerificationSchema>;

export const GuestVerificationResponseSchema = z.object({ verification: GuestVerificationSchema });
export type GuestVerificationResponse = z.infer<typeof GuestVerificationResponseSchema>;

/** Sending a code says only that it was accepted for sending. */
export const VerificationCodeSentResponseSchema = z.object({
  sent: z.literal(true),
  expiresInMinutes: z.number().int().positive(),
});
export type VerificationCodeSentResponse = z.infer<typeof VerificationCodeSentResponseSchema>;
