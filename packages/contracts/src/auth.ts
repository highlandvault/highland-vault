import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const EmailInputSchema = z.string().trim().min(3).max(254);
export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** POST /auth/register */
export const RegisterRequestSchema = z.strictObject({
  email: EmailInputSchema,
  password: PasswordSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** POST /auth/login. The password length is not policed here: old passwords must still work. */
export const LoginRequestSchema = z.strictObject({
  email: EmailInputSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Login / registration result. `mfa_required`: the session exists but is not
 * usable until POST /auth/mfa/verify succeeds.
 */
export const LoginResponseSchema = z.object({
  status: z.enum(['authenticated', 'mfa_required']),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const TotpCodeSchema = z.string().regex(/^\d{6}$/, 'must be a 6-digit code');
export const RecoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z2-7]{4}(-?[A-Za-z2-7]{4}){3}$/, 'must be a recovery code');

/** POST /auth/mfa/verify — second factor at sign-in, and step-up for sensitive operations. */
export const MfaVerifyRequestSchema = z.union([
  z.strictObject({ code: TotpCodeSchema }),
  z.strictObject({ recoveryCode: RecoveryCodeSchema }),
]);
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/** POST /auth/mfa/totp/setup */
export const TotpSetupResponseSchema = z.object({
  /** Base32 secret for manual entry. Shown once. */
  secret: z.string(),
  /** otpauth:// URI for authenticator apps (render as a QR code). */
  otpauthUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

/** POST /auth/mfa/totp/confirm */
export const TotpConfirmRequestSchema = z.strictObject({ code: TotpCodeSchema });
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequestSchema>;

export const TotpConfirmResponseSchema = z.object({
  /** Single-use recovery codes. Shown once; only hashes are stored. */
  recoveryCodes: z.array(z.string()),
});
export type TotpConfirmResponse = z.infer<typeof TotpConfirmResponseSchema>;

export const RoleGrantSchema = z.object({
  role: z.string(),
  /** null = all markets */
  market: z.string().nullable(),
});

export const PermissionGrantSchema = z.object({
  permission: z.string(),
  /** null = all markets */
  market: z.string().nullable(),
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

/** GET /auth/me */
export const MeResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    emailVerified: z.boolean(),
    mfaEnabled: z.boolean(),
  }),
  session: z.object({
    expiresAt: z.iso.datetime(),
    mfaVerifiedAt: z.iso.datetime().nullable(),
  }),
  roles: z.array(RoleGrantSchema),
  permissions: z.array(PermissionGrantSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
