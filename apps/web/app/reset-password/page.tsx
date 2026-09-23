import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : null;
  return <main className="offline-page"><div>
    <span className="brand-mark">C</span>
    <h1>{token ? "设置新密码" : "重置密码"}</h1>
    <ResetPasswordForm token={token} />
  </div></main>;
}
