import { describe, expect, it } from "vitest";
import {
  AccountSessionSchema, SignInInputSchema, SignUpInputSchema, UpdatePasswordInputSchema, UpdateProfileInputSchema,
} from "../../src/domain/account";

describe("account input authority", () => {
  it("trims email and display names without changing password bytes", () => {
    const parsed = SignUpInputSchema.parse({ email: "  learner@example.com  ", password: "  long password  ", displayName: "  Learner " });
    expect(parsed.email).toBe("learner@example.com");
    expect(parsed.displayName).toBe("Learner");
    expect(parsed.password).toBe("  long password  ");
    expect(SignInInputSchema.safeParse({ email: "learner@example.com", password: "old" }).success).toBe(true);
    expect(UpdatePasswordInputSchema.safeParse({ password: "too-short" }).success).toBe(false);
  });

  it("rejects client permissions and profile fields outside the allowlist", () => {
    expect(UpdateProfileInputSchema.safeParse({ expectedRevision: 1, displayName: "Learner", level: 5 }).success).toBe(false);
    expect(UpdateProfileInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(UpdateProfileInputSchema.safeParse({ expectedRevision: 1, defaultContentLanguage: "ru" }).success).toBe(true);
    expect(UpdateProfileInputSchema.safeParse({ expectedRevision: 1, defaultContentLanguage: null }).success).toBe(true);
    expect(SignUpInputSchema.safeParse({ email: "learner@example.com", password: "long-enough-password", role: "admin" }).success).toBe(false);
  });

  it("rejects a session joined to another account's profile", () => {
    const payload = {
      identity: { id: "550e8400-e29b-41d4-a716-446655440000", email: "learner@example.com", emailConfirmed: true },
      profile: {
        id: "550e8400-e29b-41d4-a716-446655440001", displayName: null, defaultContentLanguage: null,
        revision: 1, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
      },
    };
    expect(AccountSessionSchema.safeParse(payload).success).toBe(false);
  });
});
