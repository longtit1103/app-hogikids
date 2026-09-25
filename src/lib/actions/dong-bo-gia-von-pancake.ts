"use server";

import path from "node:path";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import {
  giuKhoaViecNang,
  kiemGiuKhoaTrongTransaction,
  MatKhoaViecNang,
  traKhoaViecNang,
} from "@/lib/backup/khoa-viec-nang";
import { capNhatSoLechGiaVon } from "@/lib/gia-von/cap-nhat-so-lech";
import { docDeXuatGiaVon } from "@/lib/gia-von/doc-de-xuat-gia-von";
import { vanTayDeXuat, type CheDoDoiChieu } from "@/lib/gia-von/doi-chieu-gia-von";
import {
  ghiGiaVonTheoPancake,
  LoiDungGiuaChung,
  VIEC_GHI_GIA_VON,
} from "@/lib/gia-von/ghi-gia-von-theo-pancake";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Áp giá vốn Pancake cho các biến thể đang lệch — bản BẤM NÚT của
 * `scripts/doi-chieu-gia-von-pancake.ts --ghi`.
 *
 * VÌ SAO CÓ: `Variant.costPrice` là APP-OWNED (bất biến #5) nên giá Pancake không tự chảy vào; đến
 * 2026-09-07 cách duy nhất để áp là chủ shop NHỚ mà báo rồi có người chạy CLI trên máy dev. Chủ shop
 * phàn nàn đúng: quy trình dựa vào trí nhớ thì kiểu gì cũng hỏng.
 *
 * BẤT BIẾN #5 KHÔNG BỊ NỚI. Lập luận "công cụ này là đường NHẬP TAY HÀNG LOẠT có người duyệt" vẫn
 * nguyên vẹn — chỉ đổi chỗ bấm từ terminal sang trình duyệt. Đo 2026-09-07 đã bác bỏ mọi phương án
 * tự ghi không người duyệt: COGS dùng giá HIỆN HÀNH nên mỗi lượt áp viết lại lãi/lỗ mọi kỳ đã đóng
 * (91,5% ΔCOGS rơi vào hàng đã bán xong trước khi lô mới về; lãi tháng 5 đổi 10,2% chỉ vì một phiếu
 * nhập). Đó là quyết định phải có mắt người, nên màn gọi action này BẮT BUỘC hiện bảng ΔCOGS theo
 * tháng trước khi bấm.
 *
 * ĐỌC LẠI đề xuất TRONG action, không nhận danh sách từ client: trang có thể mở từ sáng, giá đã đổi;
 * và không đường nào cho phép client tự soạn danh sách dòng cần ghi.
 */
export async function apGiaVonTheoPancake(
  cheDoTho: string,
  /** Dấu vân tay của danh sách chủ shop VỪA NHÌN. Khác đi ⇒ từ chối, bắt tải lại trang. */
  vanTayLucXem: string,
): Promise<ActionResult<{ daGhi: number; boQua: number; soDeXuat: number }>> {
  await requireUser();

  // Chuẩn hoá chế độ ở BIÊN: mọi chuỗi lạ phải rơi về chế độ AN TOÀN (chỉ điền ô trống), KHÔNG
  // rơi vào nhánh ĐÈ. Giá trị này còn đi vào tên file backup nên cũng không được để chuỗi tuỳ ý.
  const cheDo: CheDoDoiChieu = cheDoTho === "theo-pancake" ? "theo-pancake" : "chi-thieu";

  // Cùng cổng với mọi action ghi khác. Literal `LOI_DANG_PHUC_HOI` là thứ lưới AST
  // `tests/khoa-bao-tri-duong-ghi.test.ts` soi để biết action này đã khai đúng đường ghi.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const { deXuat } = await docDeXuatGiaVon(cheDo);

  // "Duyệt cái gì thì ghi đúng cái đó". Danh sách đổi giữa lúc xem và lúc bấm (lượt đêm land ảnh
  // Bronze mới, hoặc chủ shop bấm Đồng bộ ngay ở tab khác) ⇒ TỪ CHỐI, không ghi gì. Bảng ΔCOGS
  // theo tháng mà chủ shop vừa dựa vào để quyết khi đó đang nói về một tập không còn tồn tại.
  const vanTayBayGio = vanTayDeXuat(deXuat);
  if (vanTayBayGio !== vanTayLucXem) {
    return {
      ok: false,
      error:
        "Danh sách vừa thay đổi (có lượt đồng bộ mới chạy xong) — chưa ghi gì. " +
        "Tải lại trang để xem con số mới rồi duyệt lại.",
      code: "DANH_SACH_DA_DOI",
    };
  }

  if (deXuat.length === 0) {
    return { ok: true, data: { daGhi: 0, boQua: 0, soDeXuat: 0 } };
  }

  // Lease CÙNG TÊN với CLI ⇒ hai đường ghi loại trừ nhau, và cả hai cùng bị lượt phục hồi chặn.
  const khoa = await giuKhoaViecNang(VIEC_GHI_GIA_VON);
  if (!khoa.the) {
    return { ok: false, error: `Đang có "${khoa.dangGiu}" chạy — thử lại sau khi việc đó xong.` };
  }
  const the = khoa.the;

  try {
    const ghiLuc = new Date();
    // Gọi thẳng lõi ghi (backup + CAS + hàng rào lease TRONG từng transaction) thay vì
    // `ghiGiaVonDuoiKhoaViecNang`: lease đã giành ở trên rồi, để hàm đó giành lần hai là tự chặn
    // chính mình. Hàng rào vẫn nguyên — đó mới là thứ đóng khe "lease hết hạn dưới chân".
    const kq = await ghiGiaVonTheoPancake(prisma, deXuat, {
      duongDanBackup: duongDanBackup(ghiLuc, cheDo),
      cheDo,
      ghiLuc,
      hangRao: (tx) => kiemGiuKhoaTrongTransaction(tx, the),
    });

    await dongBoLaiSoDem();
    dungLaiManTien();
    return { ok: true, data: { daGhi: kq.daGhi, boQua: kq.boQua, soDeXuat: deXuat.length } };
  } catch (e) {
    // Lượt bị cắt giữa chừng: đã có k dòng vào DB. Nói thẳng con số — im lặng ở đây là để chủ shop
    // tưởng chưa ghi gì rồi bấm lại trên một trạng thái nửa vời.
    // Lượt cụt giữa chừng ĐÃ đổi tiền của k dòng ⇒ vẫn phải dựng lại màn, nếu không chủ shop nhìn
    // số cũ và tưởng chưa có gì xảy ra. Đây là ca dễ sót nhất: nhánh lỗi thường bị bỏ trống.
    await dongBoLaiSoDem();
    dungLaiManTien();
    if (e instanceof LoiDungGiuaChung) {
      // `LoiDungGiuaChung.message` nhúng NGUYÊN VĂN message của lỗi gốc (Prisma…, có thể mang
      // hostname/role DB) — không được đẩy thẳng ra client. Log đủ phía server; dựng câu tiếng
      // Việt CHỈ từ các field có cấu trúc của lớp lỗi (daGhi/boQua/tong/duongDanBackup), không
      // kèm lý do thô.
      console.error("Lượt áp giá vốn bị cắt giữa chừng:", e);
      // Mất lease giữa chừng là lý do chủ shop HÀNH ĐỘNG được (chờ việc kia xong rồi chạy lại), và
      // câu của `MatKhoaViecNang` là chữ cố định, không mang chi tiết hạ tầng ⇒ giữ lại nguyên văn.
      const lyDo =
        e.cause instanceof MatKhoaViecNang
          ? e.cause.message
          : "lỗi hệ thống, xem chi tiết ở log server";
      return {
        ok: false,
        error:
          `DỪNG GIỮA CHỪNG sau ${e.daGhi + e.boQua}/${e.tong} dòng (ít nhất ${e.daGhi} đã ghi, ` +
          `${e.boQua} bỏ qua vì không còn khớp giá lúc xem) — ${lyDo}.\n` +
          `Backup "${e.duongDanBackup}" giữ giá TRƯỚC KHI GHI của cả ${e.tong} dòng đề xuất: chỉ ` +
          `hoàn nguyên dòng nào đang mang giá MỚI trong DB; dòng bị bỏ qua (chủ shop vừa sửa tay) ` +
          `thì để nguyên.`,
      };
    }
    // Phòng xa: hiện KHÔNG đường nào trong `try` ném lỗi Prisma trần (vòng ghi đã bọc mọi lỗi thành
    // `LoiDungGiuaChung`; `docDeXuatGiaVon`/`giuKhoaViecNang` nằm NGOÀI `try`). Nhánh này giữ để
    // nếu sau này ai thêm câu Prisma vào `try` thì message (có thể mang hostname/role) vẫn không
    // lọt ra client.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError ||
      e instanceof Prisma.PrismaClientUnknownRequestError ||
      e instanceof Prisma.PrismaClientInitializationError ||
      e instanceof Prisma.PrismaClientRustPanicError
    ) {
      console.error("Lỗi hạ tầng khi áp giá vốn:", e);
      return { ok: false, error: "Không áp được giá vốn — lỗi hệ thống, thử lại sau." };
    }
    console.error("Lỗi không xác định khi áp giá vốn:", e);
    return {
      ok: false,
      error: `Không áp được giá vốn: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    try {
      await traKhoaViecNang(the);
    } catch (e) {
      console.error("Không trả được khoá việc nặng sau lượt áp giá vốn — tự hết hạn tối đa 5 phút.", e);
    }
  }
}

/**
 * Thư mục backup TRONG container. KHÔNG dùng `plans/reports/` như CLI: `docker-compose.yml` chỉ
 * mount `./backups` → `/backups`, còn `plans/` không có trong image ⇒ bản chụp sẽ biến mất ở lần
 * dựng lại container kế tiếp. Mà backup mất nghĩa là mất đường lùi duy nhất sau khi đã đè giá.
 * Cùng quy ước với `src/app/api/restore/route.ts`.
 */
/** Giá vốn đổi ⇒ COGS đổi ⇒ mọi màn có số tiền đều sai nếu không dựng lại. */
function dungLaiManTien(): void {
  for (const p of ["/", "/san-pham", "/san-pham/dong-bo-gia-von", "/tai-chinh", "/kenh"]) {
    revalidatePath(p);
  }
}

/**
 * Cập nhật lại số đếm trên dải cảnh báo NGAY sau lượt ghi.
 *
 * Không có bước này thì dải vẫn kêu "N mã lệch" bằng con số của lượt đêm hôm trước cho tới 03:00
 * hôm sau — chủ shop vừa bấm xong vẫn thấy y nguyên cảnh báo, tưởng nút không ăn.
 *
 * Nuốt lỗi: đây là tín hiệu nhắc việc, hỏng nó KHÔNG được biến một lượt ghi THÀNH CÔNG thành câu
 * báo lỗi. Mốc không nhích thì lưới "quá 26 giờ" tự lo.
 */
async function dongBoLaiSoDem(): Promise<void> {
  try {
    await capNhatSoLechGiaVon();
  } catch (e) {
    console.error("Không cập nhật được số đếm lệch giá vốn sau lượt ghi (lượt đêm sẽ tự sửa).", e);
  }
}

function thuMucBackup(): string {
  // Đọc env lúc GỌI, không lúc nạp module: đọc lúc nạp thì thứ tự nạp quyết định giá trị (import
  // trong ESM được nâng lên trước mọi câu lệnh) — khó thấy và chỉ vỡ trong test.
  return process.env.BACKUP_DIR ?? "/backups";
}

function duongDanBackup(moc: Date, cheDo: string): string {
  const hai = (n: number) => String(n).padStart(2, "0");
  const ten =
    `backup-gia-von-${String(moc.getFullYear()).slice(2)}${hai(moc.getMonth() + 1)}${hai(moc.getDate())}` +
    `-${hai(moc.getHours())}${hai(moc.getMinutes())}-${cheDo}-app.json`;
  return path.join(thuMucBackup(), ten);
}
