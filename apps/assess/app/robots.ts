import type { MetadataRoute } from "next";

/** The front page may be indexed; results, invites and pair cards are personal links and stay out of search. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/r/", "/t/", "/p/", "/api/"] } };
}
