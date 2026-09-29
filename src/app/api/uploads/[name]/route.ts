import { readFile } from "node:fs/promises";
import path from "node:path";

// Allowlist tên file chặn path traversal — luật chung ở lib/branding/logo-file.ts.
import { LOGO_FILENAME_RE } from "@/lib/branding/logo-file";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
};

/**
 * GET /api/uploads/:name — serve logo shop từ `public/uploads` qua route
 * handler thay vì static `public/` serving. Lý do: `next start` (prod) chỉ
 * build danh sách file `public/` servable MỘT LẦN lúc boot — file logo ghi
 * sau boot (upload runtime) sẽ 404 tới khi container restart dù bytes đã nằm
 * trong volume mount `./uploads:/app/public/uploads` (docker-compose.yml).
 * Đọc trực tiếp từ đĩa mỗi request né hoàn toàn vấn đề đó.
 *
 * Đây là logo shop hiển thị công khai trong màn hình cài đặt đã đăng nhập —
 * không cần session guard, cố tình để public-readable (đơn giản hoá next/image
 * load), nhưng filename PHẢI qua allowlist ở trên.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await params;

  if (!LOGO_FILENAME_RE.test(name)) {
    return new Response(null, { status: 404 });
  }

  const ext = name.split(".").pop() as string;
  const filePath = path.join(process.cwd(), "public", "uploads", name);

  try {
    const buffer = await readFile(filePath);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": CONTENT_TYPE_BY_EXT[ext],
        "Cache-Control": "public, max-age=31536000, immutable", // filename có timestamp → bất biến
        "X-Content-Type-Options": "nosniff", // chặn browser sniff bytes thành type khác
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
