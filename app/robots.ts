import type { MetadataRoute } from "next";

/**
 * This is a private single-workspace application with no public content,
 * so search engines must not index any page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
