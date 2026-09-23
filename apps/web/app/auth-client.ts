"use client";

import { createAuthClient } from "better-auth/react";

// No `baseURL`: same-origin as the page that imports this, which is always true here — there is no
// separate auth host, everything is `/api/auth/*` on this same Next.js app.
export const authClient = createAuthClient();
