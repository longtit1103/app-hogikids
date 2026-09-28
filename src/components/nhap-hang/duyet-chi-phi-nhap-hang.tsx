"use client";

import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ghiChiPhiNhapHang } from "@/lib/actions/chi-phi-nhap-hang";
import { formatVnd } from "@/lib/format";
import type { PhieuNhapDeXuat } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";

/** Trần giống hệt form chi phí: Prisma `Int` (int32) chết ở 2.147.483.647. */
const TRAN_TIEN = 2_000_000_000;

/**
 * Bảng duyệt phiếu nhập + khối "Ảnh hưởng nếu ghi" + nút ghi.
 *
 * Chọn từng phiếu và SỬA ĐƯỢC số tiền là yêu cầu nghiệp vụ, không phải tiện nghi: Pancake không có
 * field "đã trả bao nhiêu" nên một phiếu có thể mới trả một phần cho nhà cung cấp — chỉ chủ shop
 * biết số thật.
 *
 * Khối ảnh hưởng phải sống theo lựa chọn hiện tại (cùng tinh thần bảng ΔCOGS bên màn giá vốn): chủ
 * shop thấy quỹ tụt bao nhiêu TRƯỚC khi bấm, và thấy câu khẳng định Lãi/Lỗ không đổi — vì "Nhập
 * hàng" là danh mục DÒNG TIỀN, `pnl.ts` lọc bỏ nó khỏi mọi phép tính lãi.
 */
export function DuyetChiPhiNhapHang({
  deXuat,
  vanTay,
  quyHomNay,
}: {
  deXuat: PhieuNhapDeXuat[];
  /** Vân tay danh sách lúc trang render — lượt ghi từ chối nếu danh sách đã đổi. */
  vanTay: string;
  /** Quỹ còn lại tới hôm nay; `null` = chưa mở sổ quỹ (chưa có dòng ghi tay nào). */
  quyHomNay: number | null;
}) {
  const router = useRouter();
  const [dangChay, setDangChay] = useState(false);
  const [mo, setMo] = useState(false);
  // Mặc định CHỌN HẾT: phần lớn lượt duyệt là "đúng hết, ghi đi".
  const [chon, setChon] = useState<Set<string>>(() => new Set(deXuat.map((d) => d.uuid)));
  // Ô tiền giữ CHUỖI (không số): người dùng xoá trắng ô để gõ lại là trạng thái hợp lệ giữa chừng,
  // ép về số ngay sẽ nhảy về 0 dưới tay họ.
  const [tien, setTien] = useState<Record<string, string>>(() =>
    Object.fromEntries(deXuat.map((d) => [d.uuid, String(d.soTien)])),
  );

  const dangChon = useMemo(() => deXuat.filter((d) => chon.has(d.uuid)), [deXuat, chon]);
  const hopLe = dangChon.every((d) => soTienHopLe(tien[d.uuid]));
  // Ô đang sai (trống/không phải số) tính là 0 để khối "Ảnh hưởng nếu ghi" không hiện NaN; nút ghi
  // đã bị `hopLe` chặn nên con số này không bao giờ là thứ được đem đi ghi.
  const tongChon = dangChon.reduce(
    (s, d) => s + (soTienHopLe(tien[d.uuid]) ? docSoTien(tien[d.uuid]) : 0),
    0,
  );

  async function ghi() {
    setDangChay(true);
    try {
      const kq = await ghiChiPhiNhapHang({
        vanTay,
        chon: dangChon.map((d) => ({ uuid: d.uuid, soTien: docSoTien(tien[d.uuid]) })),
      });
      if (!kq.ok) {
        toast.error(kq.error);
        // Danh sách đã đổi ⇒ đóng hộp + tải lại, đừng để chủ shop bấm lại trên bảng cũ.
        if (kq.code === "DANH_SACH_DA_DOI" || kq.code === "DA_GHI_ROI") {
          setMo(false);
          router.refresh();
        }
        return;
      }
      setMo(false);
      const { daGhi, boQua, tongTien } = kq.data;
      toast.success(
        boQua > 0
          ? `Đã ghi ${daGhi} phiếu. ${boQua} phiếu bỏ qua vì đã có trong sổ — tải lại trang để xem phần còn lại.`
          : `Đã ghi ${daGhi} phiếu nhập, tổng ${formatVnd(tongTien)} vào Sổ chi phí.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(`Không ghi được: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDangChay(false);
    }
  }

  function bat(uuid: string) {
    setChon((truoc) => {
      const sau = new Set(truoc);
      if (sau.has(uuid)) sau.delete(uuid);
      else sau.add(uuid);
      return sau;
    });
  }

  return (
    <>
      <section className="flex flex-col gap-2">
        <h2 className="font-serif text-lg text-ink">Phiếu nhập chờ ghi sổ</h2>
        <div className="overflow-x-auto rounded-lg border border-hairline">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-surface-soft text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <Checkbox
                    aria-label="Chọn tất cả phiếu"
                    checked={chon.size === deXuat.length}
                    onCheckedChange={(v) =>
                      setChon(v ? new Set(deXuat.map((d) => d.uuid)) : new Set())
                    }
                  />
                </th>
                <th className="px-3 py-2 font-medium">Ngày</th>
                <th className="px-3 py-2 font-medium">Phiếu</th>
                <th className="px-3 py-2 font-medium">Nhà cung cấp</th>
                <th className="px-3 py-2 text-right font-medium">SL</th>
                <th className="px-3 py-2 text-right font-medium">Dòng hàng</th>
                <th className="px-3 py-2 font-medium">Ghi chú phiếu</th>
                <th className="px-3 py-2 text-right font-medium">Số tiền ghi sổ</th>
              </tr>
            </thead>
            <tbody>
              {deXuat.map((d) => {
                const daChon = chon.has(d.uuid);
                const oSai = daChon && !soTienHopLe(tien[d.uuid]);
                return (
                  <tr key={d.uuid} className="border-t border-hairline">
                    <td className="px-3 py-2">
                      <Checkbox
                        aria-label={`Chọn phiếu #${d.displayId ?? d.uuid.slice(0, 8)}`}
                        checked={daChon}
                        onCheckedChange={() => bat(d.uuid)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink">
                      {format(d.ngay, "dd/MM/yyyy")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink">
                      #{d.displayId ?? d.uuid.slice(0, 8)}
                      {/* Dấu hiệu NGAY TRÊN DÒNG, không chỉ ở khối cảnh báo chung: khối chung dễ bị
                          lướt qua, mà lệch lưới kiểm là dấu hiệu chính số tiền dòng này đáng ngờ. */}
                      {d.lechLuoiKiem && (
                        <span
                          className="ml-2 rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 text-xs text-ink"
                          title="Pancake khai tổng khác với tổng các dòng hàng — kiểm lại bên Pancake"
                        >
                          lệch
                        </span>
                      )}
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-muted-foreground">
                      {d.nhaCungCap ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {d.soLuong.toLocaleString("vi-VN")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {d.soDongHang.toLocaleString("vi-VN")}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-muted-foreground" title={d.ghiChu ?? ""}>
                      {d.ghiChu ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        inputMode="numeric"
                        aria-label={`Số tiền ghi sổ cho phiếu #${d.displayId ?? d.uuid.slice(0, 8)}`}
                        aria-invalid={oSai || undefined}
                        disabled={!daChon}
                        className="w-36 text-right tabular-nums"
                        // Hiển thị có dấu chấm ngăn nghìn như mọi ô tiền khác trong app
                        // (`expense-form-modal.tsx`) — state bên dưới vẫn giữ chuỗi số sạch
                        // (không dấu chấm) để không đổi logic `docSoTien`/`soTienHopLe`.
                        value={
                          tien[d.uuid] ? new Intl.NumberFormat("vi-VN").format(Number(tien[d.uuid])) : ""
                        }
                        onChange={(e) =>
                          setTien((t) => ({ ...t, [d.uuid]: locSoTuChuoiNhap(e.target.value) }))
                        }
                      />
                      {oSai && (
                        <p className="mt-1 text-xs text-error">Số nguyên dương, tối đa 2 tỷ</p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Số tiền mặc định là tổng Pancake khai. Sửa lại nếu bạn mới trả một phần cho nhà cung cấp —
          Pancake không lưu số đã trả, chỉ bạn biết.
        </p>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-hairline bg-surface-card p-4">
        <h2 className="font-serif text-lg text-ink">Ảnh hưởng nếu ghi</h2>
        <p className="text-sm text-ink">
          Đang chọn <strong>{dangChon.length.toLocaleString("vi-VN")}</strong> phiếu, tổng{" "}
          <strong>{formatVnd(tongChon)}</strong>.
        </p>
        {quyHomNay === null ? (
          <p className="text-sm text-muted-foreground">
            Chưa mở sổ quỹ nên chưa có số &quot;Quỹ còn lại&quot; để so — ghi xong bạn sẽ thấy khoản
            này trừ vào quỹ ngay khi sổ quỹ có dòng đầu tiên.
          </p>
        ) : (
          <p className="text-sm text-ink">
            Quỹ còn lại: <strong>{formatVnd(quyHomNay)}</strong> →{" "}
            <strong>{formatVnd(quyHomNay - tongChon)}</strong> (giảm {formatVnd(tongChon)}).
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          <strong className="text-ink">Lãi/Lỗ KHÔNG đổi</strong> — Nhập hàng là dòng tiền, không phải
          chi phí kinh doanh. Tiền hàng chỉ vào Lãi/Lỗ dưới dạng giá vốn khi món hàng được bán ra.
        </p>
      </section>

      <Dialog open={mo} onOpenChange={setMo}>
        <DialogTrigger
          render={
            <Button className="self-start" disabled={dangChon.length === 0 || !hopLe}>
              Ghi {dangChon.length.toLocaleString("vi-VN")} phiếu vào Sổ chi phí
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xác nhận ghi chi phí nhập hàng</DialogTitle>
            <DialogDescription>Xem kỹ trước khi bấm — thao tác này trừ tiền khỏi quỹ.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Sẽ ghi <strong>{dangChon.length.toLocaleString("vi-VN")}</strong> dòng vào Sổ chi phí,
              danh mục <strong>Nhập hàng</strong>, tổng <strong>{formatVnd(tongChon)}</strong>.
            </p>
            {quyHomNay !== null && (
              <p>
                Quỹ còn lại sẽ về <strong>{formatVnd(quyHomNay - tongChon)}</strong>. Lãi/Lỗ không đổi.
              </p>
            )}
            <p className="text-muted-foreground">
              Ghi nhầm vẫn sửa hoặc xoá được từng dòng trong Sổ chi phí.
            </p>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Huỷ</Button>} />
            <Button onClick={ghi} disabled={dangChay}>
              {dangChay ? "Đang ghi…" : "Ghi vào sổ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Lọc input gõ tay về chuỗi số sạch, giống hệt `parseAmountInput` của form chi phí
 * (`expense-form-modal.tsx`): bỏ mọi ký tự không phải chữ số (kể cả dấu chấm người dùng tự gõ hay
 * dấu chấm hiển thị bị chọn-dán lại), rồi kẹp trần ngay lúc gõ để không có cửa vượt `TRAN_TIEN`
 * giữa chừng. Trả về "" khi không còn chữ số nào (ô trống hợp lệ để gõ lại).
 */
function locSoTuChuoiNhap(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return String(Math.min(Number.parseInt(digits, 10), TRAN_TIEN));
}

/** `NaN` = ô trống hoặc không phải số nguyên — `soTienHopLe` bên dưới là cổng duy nhất quyết hợp lệ. */
function docSoTien(tho: string | undefined): number {
  const n = Number((tho ?? "").trim());
  return Number.isInteger(n) ? n : NaN;
}

function soTienHopLe(tho: string | undefined): boolean {
  const n = docSoTien(tho);
  return Number.isInteger(n) && n > 0 && n <= TRAN_TIEN;
}
