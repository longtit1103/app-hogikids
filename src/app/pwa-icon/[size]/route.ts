import { dungIconPng, laKichThuocIcon } from "@/lib/branding/app-icon";

/**
 * GET /pwa-icon/{180|192|512} — icon app cho màn hình chính iPhone (180, gắn qua
 * `metadata.icons.apple`) và manifest (192/512). Cố ý là route handler thường chứ không phải file
 * convention `apple-icon.tsx`: convention do Next quản header nên không bảo đảm được `no-store`.
 * Không cần phiên app — cùng mức lộ với `/api/uploads` (logo vốn public-readable); vẫn sau
 * Cloudflare Access như mọi route.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ size: string }> },
): Promise<Response> {
  const { size } = await params;
  const n = Number(size);
  if (!/^\d+$/.test(size) || !laKichThuocIcon(n)) {
    return new Response(null, { status: 404 });
  }
  return dungIconPng(n);
}
