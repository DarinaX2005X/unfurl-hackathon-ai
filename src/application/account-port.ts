import { z } from "zod";
import {
  AccountSessionSchema,
  type AuthenticatedResult, type PasswordResetRequest, type PasswordResetRequested,
  type PasswordUpdated, type Profile, type SignInInput, type SignUpInput,
  type SignUpResult, type SignedOut, type UpdatePasswordInput, type UpdateProfileInput,
} from "../domain/account";
import type { ServiceResult } from "./ports";

export const AccountStateSchema = z.object({
  session: AccountSessionSchema.nullable(),
  capabilities: z.object({
    generation: z.boolean(),
    cloudIdentity: z.boolean(),
    cloudPersistence: z.boolean(),
  }).strict(),
}).strict();

export type AccountState = z.infer<typeof AccountStateSchema>;

export interface AccountPort {
  getSession(signal?: AbortSignal): Promise<ServiceResult<AccountState>>;
  signIn(input: SignInInput, signal?: AbortSignal): Promise<ServiceResult<AuthenticatedResult>>;
  signUp(input: SignUpInput, signal?: AbortSignal): Promise<ServiceResult<SignUpResult>>;
  requestPasswordReset(input: PasswordResetRequest, signal?: AbortSignal): Promise<ServiceResult<PasswordResetRequested>>;
  updatePassword(input: UpdatePasswordInput, signal?: AbortSignal): Promise<ServiceResult<PasswordUpdated>>;
  signOut(signal?: AbortSignal): Promise<ServiceResult<SignedOut>>;
  updateProfile(input: UpdateProfileInput, signal?: AbortSignal): Promise<ServiceResult<Profile>>;
}
