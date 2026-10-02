/**
 * GET /api/investigations/:paymentId
 *
 * The read-only Milestone I surface. It composes the investigation and translates the outcome
 * into a status code; it contains no policy logic of its own, because the verdict comes from
 * Milestone G and the explanation from Milestone H.
 *
 * Status mapping (from `HTTP_STATUS_BY_CODE`):
 *
 *   200  an investigation reached a conclusion. NOTE this includes the case where the advisory
 *        layer was unavailable: the deterministic verdict is still correct and still returned,
 *        with `investigator.status: "UNAVAILABLE"` to say so.
 *   400  the payment id is not a decimal integer. Rejected before any database, RPC or AI call.
 *   404  no such payment in the index.
 *   422  the state cannot be stated as asked — the index and the chain disagree on something
 *        the verdict depends on, the payment is not on-chain, or the off-chain policy mirror
 *        disagrees with the contract. The payload carries the reason and the reconciliation
 *        report. Never a fabricated verdict.
 *   503  the index or the chain could not be read. No verdict is claimed.
 *
 * Response bodies never contain stack traces, credentials, RPC URLs or database details: errors
 * carry a stable `code` and a short human-readable `message`.
 *
 * No retry, no caching and no write of any kind. Investigation is a pure read, so re-running it
 * is safe and cheap to let the caller control.
 */
import { investigatePayment } from "@/lib/investigation/service";
import { investigationDeps } from "@/lib/investigation/deps";
import { HTTP_STATUS_BY_CODE, type InvestigationOutcome } from "@/lib/investigation/types";

export const dynamic = "force-dynamic";

/**
 * Next.js 16 route context: `params` is a Promise and must be awaited. Typed structurally
 * rather than with the generated `RouteContext` helper so `tsc --noEmit` is meaningful before a
 * build has regenerated `.next/types`.
 */
type RouteContext = { params: Promise<{ paymentId: string }> };

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      // An investigation response is per-requester data derived from public chain state; it must
      // not be cached by an intermediary that has no idea what policy it was computed under.
      "content-type": "application/json; charset=utf-8",
    },
  });
}

/**
 * Maps an investigation outcome onto an HTTP response.
 *
 * Exported so the status mapping can be tested directly, without standing up Prisma and an RPC
 * endpoint to produce an outcome that the mapping itself is the only interesting part of.
 */
export function toResponse(outcome: InvestigationOutcome): Response {
  if (!outcome.ok) {
    const status = HTTP_STATUS_BY_CODE[outcome.error.code];
    // `result` is null for input/lookup failures and populated for 422s, where the caller needs
    // the deterministic policy view and the reconciliation report to understand the refusal.
    return json(
      outcome.result ? { error: outcome.error, investigation: outcome.result } : { error: outcome.error },
      status,
    );
  }

  return json(outcome.result, 200);
}

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  let outcome: InvestigationOutcome;
  try {
    const { paymentId } = await ctx.params;
    outcome = await investigatePayment(paymentId, investigationDeps());
  } catch {
    // The service is written not to throw, so reaching here means something unforeseen — a
    // wiring fault rather than a bad request. Report it as unavailable and leak nothing.
    return json(
      { error: { code: "DEPENDENCY_UNAVAILABLE", message: "the investigation could not be performed" } },
      503,
    );
  }

  return toResponse(outcome);
}