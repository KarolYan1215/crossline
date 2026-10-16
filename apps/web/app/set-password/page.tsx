import { requireSessionContext } from "../../lib/access-guard";
import { AuthLayout } from "../login/auth-layout";
import { LOGIN_SERIF } from "../ui/serif-strings";
import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";

/** After the first sign-in by email code: offer a password so the password way in works too (skippable; Settings offers it again). */
export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await requireSessionContext();
  const { next } = await searchParams;
  // Only a path on this site, never another origin.
  const target = next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/connect";
  return <AuthLayout title={LOGIN_SERIF.setPassword}><SetPasswordForm next={target} /></AuthLayout>;
}
