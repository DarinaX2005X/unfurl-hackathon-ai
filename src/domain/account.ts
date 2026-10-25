import { z } from "zod";
import { ContentLanguageSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "./common";

export const ProfileSchema = z.object({
  id: IdSchema,
  displayName: z.string().trim().min(1).max(80).nullable(),
  defaultContentLanguage: ContentLanguageSchema.nullable(),
  revision: RevisionSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();

export const AccountIdentitySchema = z.object({
  id: IdSchema,
  email: z.email().max(254).nullable(),
  emailConfirmed: z.boolean(),
}).strict();

export const AccountSessionSchema = z.object({
  identity: AccountIdentitySchema,
  profile: ProfileSchema,
}).strict().refine((session) => session.identity.id === session.profile.id, {
  message: "The profile must belong to the signed-in account",
  path: ["profile", "id"],
});

const EmailSchema = z.string().trim().pipe(z.email().max(254));
const ReturnToSchema = z.string().max(2_048).optional();
export const NewPasswordSchema = z.string().min(12).max(128);

export const SignInInputSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
  returnTo: ReturnToSchema,
}).strict();

export const SignUpInputSchema = z.object({
  email: EmailSchema,
  password: NewPasswordSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
  returnTo: ReturnToSchema,
}).strict();

export const PasswordResetRequestSchema = z.object({
  email: EmailSchema,
  returnTo: ReturnToSchema,
}).strict();

export const UpdatePasswordInputSchema = z.object({
  password: NewPasswordSchema,
  returnTo: ReturnToSchema,
}).strict();

export const UpdateProfileInputSchema = z.object({
  expectedRevision: RevisionSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
  defaultContentLanguage: ContentLanguageSchema.nullable().optional(),
}).strict().refine((input) => input.displayName !== undefined || input.defaultContentLanguage !== undefined, {
  message: "Choose a profile field to update",
});

export const AuthenticatedResultSchema = z.object({
  status: z.literal("authenticated"),
  session: AccountSessionSchema,
  redirectTo: z.string().min(1).max(2_048),
}).strict();

export const SignUpResultSchema = z.discriminatedUnion("status", [
  AuthenticatedResultSchema,
  z.object({
    status: z.literal("confirmation_required"),
    email: z.email().max(254),
    returnTo: z.string().min(1).max(2_048),
  }).strict(),
]);

export const PasswordResetRequestedSchema = z.object({
  status: z.literal("recovery_email_requested"),
}).strict();

export const PasswordUpdatedSchema = z.object({
  status: z.literal("password_updated"),
  redirectTo: z.string().min(1).max(2_048),
}).strict();

export const SignedOutSchema = z.object({
  status: z.literal("signed_out"),
  redirectTo: z.literal("/"),
}).strict();

export type Profile = z.infer<typeof ProfileSchema>;
export type AccountIdentity = z.infer<typeof AccountIdentitySchema>;
export type AccountSession = z.infer<typeof AccountSessionSchema>;
export type SignInInput = z.infer<typeof SignInInputSchema>;
export type SignUpInput = z.infer<typeof SignUpInputSchema>;
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;
export type UpdatePasswordInput = z.infer<typeof UpdatePasswordInputSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;
export type AuthenticatedResult = z.infer<typeof AuthenticatedResultSchema>;
export type SignUpResult = z.infer<typeof SignUpResultSchema>;
export type PasswordResetRequested = z.infer<typeof PasswordResetRequestedSchema>;
export type PasswordUpdated = z.infer<typeof PasswordUpdatedSchema>;
export type SignedOut = z.infer<typeof SignedOutSchema>;
