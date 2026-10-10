import { LoginForm } from "./login-form";
import { isEmailAuthConfigured, isGoogleAuthConfigured } from "../../lib/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string }> }) {
  const { verified } = await searchParams;
  return <main className="offline-page"><div>
    <span className="brand-mark">C</span>
    <h1>登录 Crossline</h1>
    <LoginForm googleEnabled={isGoogleAuthConfigured()} emailEnabled={isEmailAuthConfigured()} verified={verified === "1"} />
  </div></main>;
}
