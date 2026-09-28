/**
 * Kiểu chia sẻ cho sync actions. Để NGOÀI file "use server" (`sync.ts`) — theo quy ước
 * codebase (xem `action-result.ts`): file "use server" chỉ export async function.
 */
export type LatestSync = {
  status: "RUNNING" | "OK" | "ERROR";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
} | null;
