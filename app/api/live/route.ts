/**
 * Lightweight process liveness probe for container orchestrators.
 *
 * Keep storage and provider checks in /api/health: a liveness probe should
 * only prove that the Next.js process can answer requests, otherwise a slow
 * or temporarily unavailable data volume can cause a destructive restart
 * loop. The deeper health endpoint remains available for readiness checks.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
