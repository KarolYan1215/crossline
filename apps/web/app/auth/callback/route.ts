import "server-only";
import { getAuth } from "../../../lib/auth";

/**
 * Sign in with ChatGPT's callback. OpenAI's open-source flow accepts only `http://127.0.0.1:<port>/auth/callback`, a path outside Better
 * Auth's `/api/auth`, so this hands the request to the `/chatgpt/callback` endpoint unchanged (query and cookies). GET only: OpenAI
 * redirects the browser here, and the endpoint checks the signed state cookie and the token itself.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return getAuth().handler(new Request(`${url.origin}/api/auth/chatgpt/callback${url.search}`, { headers: request.headers }));
}
