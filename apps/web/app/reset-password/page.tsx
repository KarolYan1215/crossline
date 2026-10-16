import { ResetPasswordForm } from "./reset-password-form";
import { AuthLayout } from "../login/auth-layout";
import { LOGIN_SERIF } from "../ui/serif-strings";
import { getLocale } from "../../lib/locale";

export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : null;
  return <AuthLayout title={token ? LOGIN_SERIF.newPassword : LOGIN_SERIF.reset} locale={await getLocale()}><ResetPasswordForm token={token} /></AuthLayout>;
}
