import { z } from "zod";

import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { huongDanCatTayPhienKhacRole } from "@/lib/backup/huong-dan-cat-tay-phien-khac-role";
import { catPhienGiuKhoaChung, type KetQuaCatPhien } from "@/lib/backup/khoa-chung-cli";
import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";
import { ghiNhatKy, ghiNhatKyLoi, type ActorNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import { congChuShopRoute } from "@/lib/quyen/cong-route";
import { cauHinhClientKhoa } from "@/lib/tao-prisma-client";

/**
 * `backendStart` (ISO, từ chính danh sách 409) tuỳ chọn: có thì phiên phải khớp — pid của danh sách cũ
 * có thể đã thuộc về một phiên mới.
 */
const BODY_SCHEMA = z.object({ pid: z.number().int().positive(), backendStart: z.string().datetime().optional() });

/** Mã lý do CỐ ĐỊNH cho nhật ký (không chép chuỗi từ client vào `ghiChu`). */
const LY_DO_CAT_PHIEN = "CAT_PHIEN_GIU_KHOA_GHI_CHUNG";
const LY_DO_KHONG_GIU_KHOA = "PHIEN_KHONG_CON_GIU_KHOA_GHI_CHUNG";
const LY_DO_KHAC_ROLE = "PHIEN_THUOC_ROLE_KHAC";

/**
 * POST /api/restore/cat-phien — cắt MỘT phiên DB của script CLI đang chặn lượt phục hồi (kết nối giữ
 * khoá ghi chung HOẶC kết nối pool của script mồ côi), để lượt phục hồi bị 409 `phienDangGiu` thử lại
 * được. Body `{ pid, backendStart? }` lấy từ chính danh sách 409 của `/api/restore`. Chỉ chủ shop, cùng
 * cổng + chống CSRF với `/api/restore`. Lượt phục hồi KHÔNG tự cắt ngầm — chủ shop bấm.
 *
 * Không qua `routeQuaCua`: route này không ghi dữ liệu app — chỉ gọi `pg_terminate_backend` (xem
 * `catPhienGiuKhoaChung`: chỉ phiên CLI cùng role, cùng DB; KHÔNG BAO GIỜ phiên giữ X hay phiên mang
 * tiền tố của lượt phục hồi). Nhật ký thao tác là best-effort như dòng OK của `/api/restore`.
 *
 * Ba kết cục: cắt xong (200); phiên role KHÁC (409 + `khacRole: true` + câu hướng dẫn cắt tay bằng
 * superuser — modal giữ dòng); pid không còn chặn (409 — đã tự thoát / pid đổi chủ, modal gỡ dòng).
 *
 * Từ chối thêm khi đang có lượt phục hồi chạy (cờ bảo trì bật) — lớp chặn ngoài; khe giữa lúc lượt
 * phục hồi giành X và lúc bật cờ do chính `catPhienGiuKhoaChung` chặn (không cắt phiên giữ X).
 */
export async function POST(request: Request): Promise<Response> {
  const cong = await congChuShopRoute();
  if (!cong.ok) return cong.response;

  const khacOrigin = chanRequestKhacOrigin(request);
  if (khacOrigin) return khacOrigin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Thân request không phải JSON." }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Thiếu hoặc sai pid của phiên cần cắt." }, { status: 400 });
  }
  const { pid, backendStart } = parsed.data;

  if (dangPhucHoi()) {
    return Response.json(
      { error: "Đang có một lượt phục hồi chạy — không cắt phiên lúc này. Chờ xong rồi thử lại." },
      { status: 409 },
    );
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return Response.json({ error: "DATABASE_URL chưa được cấu hình." }, { status: 500 });

  const actor: ActorNhatKy = { id: cong.nguoiDung.id, email: cong.nguoiDung.email };
  const doiTuong = { loai: "PhienDb", id: String(pid), moTa: "Phiên script chặn lượt phục hồi" };

  let kq: KetQuaCatPhien;
  try {
    kq = await catPhienGiuKhoaChung(cauHinhClientKhoa(dbUrl, "hogikids-cat-phien"), pid, backendStart);
  } catch (err) {
    console.error("[cat-phien] Không cắt được phiên script:", err);
    return Response.json({ error: "Không cắt được phiên — cơ sở dữ liệu không phản hồi. Thử lại sau." }, { status: 500 });
  }

  if (kq.ketQua === "khac-role") {
    // Phiên VẪN đang sống và có thể vẫn chặn phục hồi — trả cờ `khacRole` để modal GIỮ dòng (đổi sang
    // nhóm "cần cắt tay") thay vì gỡ đi như phiên đã tự thoát.
    await ghiNhatKyLoi({ hanhDong: HANH_DONG.PHUC_HOI_CAT_PHIEN, actor, doiTuong, ghiChu: { lyDo: LY_DO_KHAC_ROLE } });
    return Response.json(
      { error: huongDanCatTayPhienKhacRole(pid, kq.usename), khacRole: true, usename: kq.usename },
      { status: 409 },
    );
  }

  if (kq.ketQua === "khong-chan") {
    await ghiNhatKyLoi({ hanhDong: HANH_DONG.PHUC_HOI_CAT_PHIEN, actor, doiTuong, ghiChu: { lyDo: LY_DO_KHONG_GIU_KHOA } });
    return Response.json(
      { error: `Phiên ${pid} không còn là phiên script chặn phục hồi (có thể đã tự thoát) — thử phục hồi lại.` },
      { status: 409 },
    );
  }

  // Phiên đã bị cắt: lỗi ghi nhật ký không được biến thao tác đã xong thành 500 (chủ shop sẽ bấm lại
  // và nhận 409 "không còn giữ khoá"). Cờ phục hồi có thể vừa bật sau câu kiểm trên ⇒ bỏ dòng.
  if (!dangPhucHoi()) {
    try {
      await ghiNhatKy(prisma, { hanhDong: HANH_DONG.PHUC_HOI_CAT_PHIEN, actor, doiTuong, ghiChu: { lyDo: LY_DO_CAT_PHIEN } });
    } catch (err) {
      console.error("[nhat-ky] Không ghi được dòng cắt phiên giữ khoá ghi chung:", err);
    }
  }
  return Response.json({ ok: true, pid });
}
