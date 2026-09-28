"use server";

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

// ---- Cài đặt › Thông tin shop (tên, SĐT, logo) ------------------------------

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB — khớp validate client (shop-info-section.tsx)
const LOGO_EXT_BY_MIME: Record<string, "png" | "jpg"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
const INVALID_LOGO_ERROR = "Ảnh phải là PNG/JPG dưới 2MB";

/**
 * Magic bytes THẬT của từng định dạng — `File.type` chỉ là MIME do TRÌNH DUYỆT
 * tự khai báo trong request, giả được (đổi tên field/Content-Type tuỳ ý qua
 * request thủ công, file không hề là ảnh). Đây là lớp kiểm THỨ HAI, đọc thẳng
 * vài byte đầu buffer thật — không tin bất cứ gì client khai báo. Cố ý KHÔNG
 * dùng thư viện xử lý ảnh (sharp/jimp…) cho việc này: chỉ so vài byte đầu,
 * thêm dependency là over-engineering và mở thêm bề mặt tấn công không cần.
 */
const MAGIC_BYTES_BY_EXT: Record<"png" | "jpg", readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
};

function hasValidMagicBytes(buffer: Buffer, ext: "png" | "jpg"): boolean {
  return MAGIC_BYTES_BY_EXT[ext].every((byte, i) => buffer[i] === byte);
}

// Phải khớp allowlist filename ở route handler đọc logo
// (`src/app/api/uploads/[name]/route.ts`) — dùng lại đúng mẫu tên mà
// `saveLogoFile` sinh ra, để nhận diện + xoá an toàn file logo CŨ (chặn path
// traversal dù chuỗi này do chính app từng ghi vào DB — phòng thủ hai lớp).
const LOGO_FILENAME_RE = /^logo-\d+\.(png|jpg)$/;

/**
 * Xoá file logo CŨ trên đĩa sau khi đã ghi xong file mới + lưu DB thành công
 * (gọi từ `updateShopInfo`, đúng thứ tự an toàn: ghi mới → cập nhật DB → xoá
 * cũ). Không có filename này thì mỗi lần đổi logo lại để lại một file mồ côi
 * vĩnh viễn trên volume mount — không ai dọn.
 *
 * Xoá lỗi (file đã bị xoá tay, quyền đĩa…) KHÔNG được làm gãy cả thao tác lưu
 * thông tin shop — chỉ log cảnh báo rồi bỏ qua.
 */
async function deleteOldLogoFile(oldShopLogoPath: string): Promise<void> {
  const filename = path.basename(oldShopLogoPath);
  if (!LOGO_FILENAME_RE.test(filename)) return;
  try {
    await unlink(path.join(process.cwd(), "public", "uploads", filename));
  } catch (e) {
    console.warn(`Không xoá được logo cũ ${filename}:`, e);
  }
}

const shopInfoSchema = z.object({
  shopName: z.string().trim().min(1, "Tên shop không được để trống").max(50, "Tên shop tối đa 50 ký tự"),
  // FormData trả "" khi input trống — coi rỗng là "không nhập" (optional), chỉ regex-check khi có giá trị.
  shopPhone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
    z.string().regex(/^0\d{9}$/, "Số điện thoại không hợp lệ").optional()
  ),
});

/**
 * Ghi file logo vào `public/uploads` — volume mount bền qua rebuild (compose
 * Task 7), KHÔNG lưu DB nên KHÔNG nằm trong pg_dump (đã biết, chấp nhận).
 * Trả về path đọc qua route handler `/api/uploads/[name]` (KHÔNG phải static
 * `/uploads/...`) vì `next start` chỉ build danh sách file `public/` servable
 * MỘT LẦN lúc boot — file ghi runtime sau boot sẽ 404 tới khi restart. Route
 * handler đọc thẳng từ đĩa nên né được vấn đề đó (xem route.ts).
 *
 * Trả về `null` khi buffer thật không khớp magic bytes của định dạng đã khai
 * (`file.type` giả được) — KHÔNG ghi gì lên đĩa trong trường hợp đó.
 */
async function saveLogoFile(file: File): Promise<string | null> {
  const ext = LOGO_EXT_BY_MIME[file.type];
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!hasValidMagicBytes(buffer, ext)) return null;

  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const filename = `logo-${Date.now()}.${ext}`;
  await writeFile(path.join(uploadsDir, filename), buffer);
  return `/api/uploads/${filename}`;
}

/**
 * Lưu Tên shop / SĐT / logo (Cài đặt › Thông tin shop). Re-validate logo ở
 * server — KHÔNG tin file input client dù đã chặn trước — sai định dạng/dung
 * lượng trả lỗi field "logo". `revalidatePath("/", "layout")` để khối user
 * cuối sidebar (avatar chữ cái + tên shop, đọc trong `(app)/layout.tsx`) đổi
 * ngay không cần F5.
 */
export async function updateShopInfo(formData: FormData): Promise<ActionResult> {
  const userId = await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = shopInfoSchema.safeParse({
    shopName: formData.get("shopName"),
    shopPhone: formData.get("shopPhone"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "shopName") };
  }

  let shopLogoPath: string | undefined;
  const logo = formData.get("logo");
  if (logo instanceof File && logo.size > 0) {
    if (!(logo.type in LOGO_EXT_BY_MIME) || logo.size > MAX_LOGO_BYTES) {
      return { ok: false, error: INVALID_LOGO_ERROR, field: "logo" };
    }
    const saved = await saveLogoFile(logo);
    if (!saved) {
      return { ok: false, error: INVALID_LOGO_ERROR, field: "logo" };
    }
    shopLogoPath = saved;
  }

  // Đọc logo CŨ trước khi ghi đè DB — chỉ cần khi thật sự có logo mới (đổi tên/SĐT
  // đơn thuần không đụng file nào). Đọc sau khi file mới đã ghi xong đĩa, để nếu
  // có lỗi ở bước này thì cùng lắm sinh thêm 1 file mồ côi, KHÔNG mất logo cũ.
  const oldShopLogoPath = shopLogoPath
    ? (await prisma.user.findUnique({ where: { id: userId }, select: { shopLogoPath: true } }))?.shopLogoPath
    : null;

  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        shopName: parsed.data.shopName,
        shopPhone: parsed.data.shopPhone ?? null,
        ...(shopLogoPath ? { shopLogoPath } : {}),
      },
    });
  } catch {
    return { ok: false, error: "Lỗi khi lưu thông tin shop" };
  }

  // Xoá file cũ CHỈ sau khi file mới đã ghi xong đĩa VÀ DB đã cập nhật thành công —
  // xoá sớm hơn mà một trong hai bước trên lỡ hỏng thì mất trắng logo, không có gì phục hồi.
  if (oldShopLogoPath && oldShopLogoPath !== shopLogoPath) {
    await deleteOldLogoFile(oldShopLogoPath);
  }

  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}
