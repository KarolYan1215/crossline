"use client";

import { createAuthClient } from "better-auth/react";

// No `baseURL`: same-origin as the page that imports this, which is always true here — there is no
// separate auth host, everything is `/api/auth/*` on this same Next.js app.
export const authClient = createAuthClient();

type AuthResult = { error: { code?: string; message?: string } | null };
/**
 * The email-code endpoints, called through the client's own fetch: the plugin-typed client's inferred type names zod internals this
 * package does not depend on, so it cannot be exported.
 */
export const emailCode = {
  send: (email: string) => authClient.$fetch("/email-otp/send-verification-otp", { method: "POST", body: { email, type: "sign-in" } }) as Promise<AuthResult>,
  signIn: (email: string, otp: string) => authClient.$fetch("/sign-in/email-otp", { method: "POST", body: { email, otp } }) as Promise<AuthResult>
};
