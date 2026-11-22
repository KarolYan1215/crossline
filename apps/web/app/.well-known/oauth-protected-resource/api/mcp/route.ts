import { GET as metadata } from "../../route";

/** The same document at the path-suffixed address (RFC 9728 §3.1), which hosts try first for `/api/mcp`. */
export const dynamic = "force-dynamic";
export const GET = metadata;
