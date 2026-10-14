import { AssessApp } from "./assess-app";

/** One static page: the whole test runs and scores in the browser. */
export default function Page() {
  return <AssessApp waitlistUrl={process.env.NEXT_PUBLIC_WAITLIST_URL ?? "https://example.com/crossline-waitlist"} />;
}
