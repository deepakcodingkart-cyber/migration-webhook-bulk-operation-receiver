import type { Phase } from "../types/index.ts";

// ─────────────────────────────────────────────────────────────
// Phase detection — migration.status → phase name
// ─────────────────────────────────────────────────────────────
// export function detectPhase(status) {
//   switch (status) {
//     case "completed":
//       return "create";
//     case "rollback_cancel_processing":
//       return "rollback_cancel";
//     case "rollback_revoke_processing":
//       return "rollback_revoke";
//     default:
//       return null;
//   }
// }

export function detectPhase(status: string | null | undefined): Phase | null {
console.log(
    "🚀 ~ file: helper.mjs ~ line 10 ~ detectPhase ~ status", status)
  if (!status) return null;
  switch (status) {
    case "migrating":
      return "create";
    case "rollback_cancelling":
      return "rollback_cancel";
    case "rollback_revoking":
      return "rollback_revoke";
    default:
      return null;
  }
}
