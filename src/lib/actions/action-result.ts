/**
 * The single result type every server action in the app must return.
 * Never redefine this shape elsewhere — import it instead.
 *
 * `code` is an optional machine-readable identifier (e.g. "DUPLICATE_SKU")
 * for callers that need to branch on the failure reason instead of just
 * displaying `error` to the user. `field` names the offending form field for
 * inline validation errors.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; field?: string; code?: string };
