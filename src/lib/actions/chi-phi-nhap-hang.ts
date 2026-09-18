"use server";

import { format } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { capNhatSoPhieuNhapChuaGhi } from "@/lib/nhap-hang/cap-nhat-so-phieu-nhap";
import { docDeXuatPhieuNhap } from "@/lib/nhap-hang/doc-phieu-nhap-bronze";
import {
  vanTayDeXuatPhieuNhap,
  type PhieuNhapDeXuat,
} from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Ghi chi phí nhập hàng từ phiếu nhập Pancake — bản BẤM DUYỆT của màn `/tai-chinh/chi-phi-nhap-hang`.
 *
 * VÌ SAO KHÔNG TỰ GHI (chủ shop chốt 17/09): Pancake KHÔNG có field "đã trả bao nhiêu" cho phiếu
 * nhập — phiếu có thể còn nợ nhà cung cấp. Chỉ chủ shop biết số đã trả, nên mỗi dòng còn có ô sửa
 * số tiền. App chỉ phát hiện và ĐỀ XUẤT.
 *
 * BẤT BIẾN TIỀN: danh mục `purchase` ("Nhập hàng") KHÔNG BAO GIỜ vào P&L (`pnl.ts` lọc bỏ) nhưng CÓ
 * trừ Sổ quỹ (`so-quy-queries.ts` không lọc danh mục). Tức mỗi lượt bấm ở đây làm QUỸ giảm mà
 * Lãi/Lỗ đứng yên — màn duyệt phải nói thẳng điều đó trước khi chủ shop bấm.
 *
 * `source: MANUAL` cố ý (không phải `IMPORT`): chủ shop phải sửa/xoá được dòng đã ghi — khoá sửa chỉ
 * áp cho `ADS_API`.
 *
 * ĐỌC LẠI đề xuất TRONG action, KHÔNG nhận danh sách từ client: client chỉ gửi uuid + số tiền đã
 * duyệt, mọi thuộc tính khác (ngày, mã phiếu, refId) lấy từ bản server vừa đọc.
 */

const chonSchema = z.object({
  uuid: z.string().min(1),
  // Cùng ràng buộc với form chi phí đang có: Prisma `Int` (int32) chết ở 2.147.483.647 nên trần
  // 2 tỷ chặn tại biên, thay vì để Postgres ném out-of-range và người dùng thấy lỗi generic.
  soTien: z.coerce
    .number()
    .int()
    .positive("Số tiền phải lớn hơn 0")
    .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
});

const ghiSchema = z.object({
  /** Vân tay danh sách chủ shop VỪA NHÌN. Khác đi ⇒ từ chối, bắt tải lại trang. */
  vanTay: z.string().min(1),
  chon: z.array(chonSchema).min(1, "Chưa chọn phiếu nào"),
});

export async function ghiChiPhiNhapHang(
  input: unknown,
): Promise<ActionResult<{ daGhi: number; boQua: number; tongTien: number }>> {
  await requireUser();

  // Cùng cổng với mọi action ghi khác. Literal `LOI_DANG_PHUC_HOI` là thứ lưới AST
  // `tests/khoa-bao-tri-duong-ghi.test.ts` soi để biết action này đã khai đúng đường ghi.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = ghiSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { vanTay, chon } = parsed.data;

  const { deXuat } = await docDeXuatPhieuNhap();

  // "Duyệt cái gì thì ghi đúng cái đó". Ảnh Bronze mới land giữa lúc xem và lúc bấm (lượt đêm 03:00,
  // hoặc chủ shop mở trang từ sáng) ⇒ TỪ CHỐI, không ghi gì. Khối "Ảnh hưởng nếu ghi" mà chủ shop
  // vừa dựa vào để quyết khi đó đang nói về một tập không còn tồn tại.
  if (vanTayDeXuatPhieuNhap(deXuat) !== vanTay) {
    return {
      ok: false,
      error:
        "Danh sách phiếu nhập vừa thay đổi (có lượt đồng bộ mới chạy xong) — chưa ghi gì. " +
        "Tải lại trang để xem danh sách mới rồi duyệt lại.",
      code: "DANH_SACH_DA_DOI",
    };
  }

  const theoUuid = new Map(deXuat.map((d) => [d.uuid, d]));
  const dong: { phieu: PhieuNhapDeXuat; soTien: number }[] = [];
  for (const c of chon) {
    const phieu = theoUuid.get(c.uuid);
    // uuid lạ = client tự soạn (hoặc trang cũ tới mức vân tay lọt khe). Không ghi gì cả: một dòng
    // tiền không truy được về phiếu Pancake nào là dòng không ai đối chiếu lại được.
    if (!phieu) {
      return {
        ok: false,
        error: "Có phiếu không còn trong danh sách đề xuất — chưa ghi gì. Tải lại trang rồi duyệt lại.",
        code: "DANH_SACH_DA_DOI",
      };
    }
    dong.push({ phieu, soTien: c.soTien });
  }

  // Phiếu đã có dòng trong sổ KHÔNG bao giờ nằm trong `deXuat` (hàm đối chiếu loại sẵn), nên ca
  // trùng chỉ xảy ra khi một tab khác vừa ghi trong đúng khe giữa lượt đọc và lượt ghi này. Tra
  // trước để NÊU ĐƯỢC TÊN phiếu trùng; `skipDuplicates` bên dưới là cổng cuối cho khe còn lại.
  const daCo = new Set(
    (
      await prisma.expense.findMany({
        where: { refId: { in: dong.map((d) => d.phieu.refId) } },
        select: { refId: true },
      })
    ).flatMap((e) => (e.refId === null ? [] : [e.refId])),
  );
  const canGhi = dong.filter((d) => !daCo.has(d.phieu.refId));

  if (canGhi.length === 0) {
    return {
      ok: false,
      error: `${dong.length === 1 ? "Phiếu này" : "Các phiếu đã chọn"} đã có trong Sổ chi phí rồi — không ghi thêm dòng nào.`,
      code: "DA_GHI_ROI",
    };
  }

  let daGhi = 0;
  try {
    // MỘT câu INSERT = một transaction ngầm: hoặc vào hết, hoặc không dòng nào. `skipDuplicates`
    // dựa trên `Expense.refId @unique` — cổng chống ghi trùng ở tầng DB; không có nó thì một phiếu
    // vừa được ghi ở tab khác sẽ làm HỎNG CẢ LƯỢT (P2002 abort transaction Postgres).
    const kq = await prisma.expense.createMany({
      data: canGhi.map((d) => ({
        date: d.phieu.ngay,
        categoryId: "purchase",
        amount: d.soTien,
        description: moTa(d.phieu),
        source: "MANUAL" as const,
        refId: d.phieu.refId,
        // Nhập hàng là dòng tiền chung của shop, không thuộc kênh bán nào.
        channelId: null,
      })),
      skipDuplicates: true,
    });
    daGhi = kq.count;
  } catch (e) {
    // `skipDuplicates` đã nuốt P2002 nên tới đây là lỗi KHÁC (mất kết nối, out-of-range…). Vẫn dịch
    // riêng P2002 phòng khi driver đổi hành vi — im lặng ở đây là chủ shop tưởng đã ghi xong.
    const code = (e as { code?: string })?.code;
    if (code === "P2002") {
      return {
        ok: false,
        error: "Một phiếu vừa được ghi ở nơi khác — chưa ghi gì. Tải lại trang rồi duyệt lại.",
        code: "DA_GHI_ROI",
      };
    }
    return {
      ok: false,
      error: `Không ghi được chi phí nhập hàng: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  await dongBoLaiSoDem();
  dungLaiManTien();

  // `tongTien` CHỈ đúng khi không phiếu nào bị bỏ (`boQua === 0`) — `createMany` không nói dòng nào
  // bị `skipDuplicates` bỏ. Client vì vậy chỉ hiện số tiền ở nhánh boQua === 0; nhánh còn lại bảo
  // tải lại trang để đọc số thật từ sổ. Đoán bừa một con số tiền còn tệ hơn không nói.
  const tongTien = canGhi.reduce((s, d) => s + d.soTien, 0);
  return { ok: true, data: { daGhi, boQua: dong.length - daGhi, tongTien } };
}

/**
 * Mô tả dòng sổ — phải tự nói được nó từ phiếu nào, vì đây là dòng tiền chục triệu mà sáu tháng sau
 * còn có người soi lại. Ghi chú phiếu do chủ shop tự gõ bên Pancake nên thường là thứ nhận ra nhanh
 * nhất; cắt cho vừa trần 200 ký tự của cột `description`.
 */
function moTa(p: PhieuNhapDeXuat): string {
  const phan = [`Phiếu nhập #${p.displayId ?? p.uuid.slice(0, 8)} ngày ${format(p.ngay, "dd/MM/yyyy")}`];
  if (p.nhaCungCap) phan.push(p.nhaCungCap);
  if (p.ghiChu) phan.push(p.ghiChu);
  return phan.join(" — ").slice(0, 200);
}

/** Chi phí đổi ⇒ quỹ và sổ chi phí đổi ⇒ mọi màn có số tiền phải dựng lại. */
function dungLaiManTien(): void {
  for (const p of ["/tai-chinh", "/tai-chinh/chi-phi-nhap-hang", "/"]) {
    revalidatePath(p);
  }
}

/**
 * Cập nhật lại số đếm trên dải nhắc việc NGAY sau lượt ghi.
 *
 * NUỐT LỖI cố ý (cùng lý do với `dong-bo-gia-von-pancake.ts`): đây là tín hiệu nhắc việc, hỏng nó
 * KHÔNG được biến một lượt ghi TIỀN THÀNH CÔNG thành câu báo lỗi. Mốc không nhích thì lưới "quá 26
 * giờ" tự lo.
 */
async function dongBoLaiSoDem(): Promise<void> {
  try {
    await capNhatSoPhieuNhapChuaGhi();
  } catch (e) {
    console.error("Không cập nhật được số phiếu nhập chờ ghi sau lượt duyệt (lượt đêm sẽ tự sửa).", e);
  }
}
