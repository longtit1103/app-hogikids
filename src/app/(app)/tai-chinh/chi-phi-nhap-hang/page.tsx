import { format } from "date-fns";
import Link from "next/link";

import { DuyetChiPhiNhapHang } from "@/components/nhap-hang/duyet-chi-phi-nhap-hang";
import { formatVnd } from "@/lib/format";
import { docDeXuatPhieuNhap } from "@/lib/nhap-hang/doc-phieu-nhap-bronze";
import { vanTayDeXuatPhieuNhap } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { requireUser } from "@/lib/session";
import { tinhQuyTuTong } from "@/lib/so-quy/cong-thuc-so-quy";
import { docTongNguon } from "@/lib/so-quy/so-quy-queries";

/**
 * Màn DUYỆT chi phí nhập hàng từ phiếu nhập Pancake.
 *
 * VÌ SAO KHÔNG TỰ GHI (chủ shop chốt 17/09): Pancake KHÔNG có field "đã trả bao nhiêu" — phiếu có
 * thể còn nợ nhà cung cấp, nên app chỉ được ĐỀ XUẤT và để chủ shop duyệt từng phiếu, sửa được số
 * tiền. Cái app bỏ đi là bước "phải NHỚ là mình vừa nhập hàng", không phải bước có mắt người.
 *
 * TRANG RIÊNG chứ không phải tab của `/tai-chinh`: hub Tài chính neo theo KỲ đang xem (picker
 * topbar), còn đề xuất ở đây là tập TOÀN LỊCH SỬ tính từ ngày mở sổ quỹ — nhét vào tab là mời chủ
 * shop hiểu nhầm rằng đổi kỳ sẽ đổi danh sách. Khuôn bày theo `/san-pham/dong-bo-gia-von`.
 */
export default async function ChiPhiNhapHangPage() {
  await requireUser("/tai-chinh/chi-phi-nhap-hang");

  const { deXuat, daGhi, boQuaTruocD0, canhBao, d0, soPhieuNhapThat } = await docDeXuatPhieuNhap();

  // Quỹ tới HÔM NAY — số để nói "ghi xong quỹ còn bao nhiêu". Đọc đúng đường `docTongNguon` mà thẻ
  // Quỹ còn lại dùng (tiền THẬT, không đụng số dự kiến), nên hai màn không bao giờ lệch nhau.
  const quyHomNay = d0 === null ? null : tinhQuyTuTong(await docTongNguon(d0, new Date()));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-ink">Chi phí nhập hàng từ Pancake</h1>
        <p className="text-sm text-muted-foreground">
          App đối chiếu phiếu nhập bên Pancake với Sổ chi phí và đề xuất những phiếu chưa vào sổ.
          App không tự ghi: Pancake không lưu số bạn đã trả cho nhà cung cấp, chỉ bạn biết.
        </p>
      </div>

      {canhBao.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-semibold text-ink">Cần kiểm lại trước khi ghi</p>
          <ul className="list-disc pl-5 text-sm text-ink">
            {canhBao.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {deXuat.length === 0 ? (
        /*
          KHÔNG được khẳng định "mọi phiếu nhập bên Pancake đều đã có trong Sổ chi phí": phiếu trước
          ngày mở sổ, phiếu đã huỷ và phiếu mang trạng thái app chưa biết đều KHÔNG vào sổ mà vẫn rơi
          vào nhánh này. Câu khẳng định sai ở đây từng che đúng ca nguy nhất — một phiếu 80 triệu
          mang mã lạ bị bỏ câm. Nói bối cảnh bằng số thật (`soPhieuNhapThat`) rồi chỉ sang khối cảnh
          báo ngay trên.
        */
        <div className="rounded-lg border border-hairline bg-surface-card p-6 text-sm text-muted-foreground">
          Không có phiếu nhập nào chờ ghi. App đã soi{" "}
          {soPhieuNhapThat.toLocaleString("vi-VN")} phiếu nhập hàng bên Pancake — những phiếu trước
          ngày mở sổ quỹ, phiếu đã huỷ và phiếu mang trạng thái app chưa biết không được đề xuất
          {canhBao.length > 0 ? " (xem phần cần kiểm lại ở trên)" : ""}. App đối chiếu lại mỗi đêm
          lúc 03:00 sau lượt đồng bộ Pancake.
        </div>
      ) : (
        <DuyetChiPhiNhapHang
          deXuat={deXuat}
          // Vân tay của ĐÚNG danh sách đang hiện trên màn — lượt ghi từ chối nếu nó đã đổi.
          vanTay={vanTayDeXuatPhieuNhap(deXuat)}
          quyHomNay={quyHomNay}
        />
      )}

      {boQuaTruocD0.soPhieu > 0 && d0 !== null && (
        <p className="text-sm text-muted-foreground">
          Đã bỏ qua {boQuaTruocD0.soPhieu.toLocaleString("vi-VN")} phiếu nhập trước ngày mở sổ quỹ (
          {format(d0, "dd/MM/yyyy")}) — tổng {formatVnd(boQuaTruocD0.tongTien)}. Tiền đó coi như đã
          nằm trong số dư mở sổ.
        </p>
      )}

      {daGhi.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-serif text-lg text-muted-foreground">
            Đã có trong sổ ({daGhi.length.toLocaleString("vi-VN")} phiếu)
          </h2>
          <div className="overflow-x-auto rounded-lg border border-hairline">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-surface-soft text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Ngày</th>
                  <th className="px-3 py-2 font-medium">Phiếu</th>
                  <th className="px-3 py-2 text-right font-medium">Sổ đang ghi</th>
                  <th className="px-3 py-2 text-right font-medium">Pancake hiện khai</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                {daGhi.map((p) => (
                  <tr key={p.uuid} className="border-t border-hairline">
                    <td className="whitespace-nowrap px-3 py-2">{format(p.ngay, "dd/MM/yyyy")}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      #{p.displayId ?? p.uuid.slice(0, 8)}
                      {p.daHuyBenPancake && (
                        <span className="ml-2 rounded border border-error/50 px-1.5 py-0.5 text-xs text-error">
                          Pancake đã huỷ
                        </span>
                      )}
                      {/*
                        Nhãn TRUNG TÍNH cho mã lạ, KHÔNG dùng màu đỏ "đã huỷ": app không biết mã này
                        nghĩa gì, mà dòng chi có thể đang đúng — gán nhầm nhãn huỷ là đẩy chủ shop đi
                        xoá một khoản chi thật.
                      */}
                      {p.trangThaiLa && (
                        <span className="ml-2 rounded border border-warning/50 px-1.5 py-0.5 text-xs text-ink">
                          Trạng thái lạ (mã {p.status})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatVnd(p.soTienDaGhi)}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${p.lechTien ? "text-error" : ""}`}
                    >
                      {formatVnd(p.soTien)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Sửa hoặc xoá các dòng này ở{" "}
            <Link href="/tai-chinh?tab=so-chi-phi" className="underline">
              Sổ chi phí
            </Link>
            .
          </p>
        </section>
      )}
    </div>
  );
}
