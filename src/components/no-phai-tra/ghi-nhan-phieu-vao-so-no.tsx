"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
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
import { ghiNhanPhieuVaoSoNo } from "@/lib/actions/phieu-nhap-no";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import type { PhieuChoGhiNo } from "@/lib/no-phai-tra/doc-phieu-cho-ghi-no";

/**
 * Màn duyệt phiếu nhập SAU khi bật theo dõi nợ: mỗi phiếu → "Ghi nhận vào sổ nợ" (tạo hồ sơ nghĩa vụ,
 * KHÔNG đổi quỹ). Khác màn cũ: bỏ ô sửa tiền ghi sổ — tổng phiếu = `total_price` Pancake, phần đã trả là
 * thông tin riêng:
 *  - phiếu CÓ dòng Sổ chi phí (cũ): đã trả trước = số dòng đó (chỉ đọc);
 *  - phiếu TRƯỚC ngày mở sổ D0: ô "Đã trả trước" gõ tay; gõ KHÁC số Sổ chi phí (nếu có) ⇒ CHỈ chủ shop,
 *    kèm "Lý do lệch" (không có dòng Sổ chi phí thì không có số nguồn để lệch, không cần lý do);
 *  - phiếu từ D0 trở đi, không dòng Sổ chi phí: đã trả trước = 0 (tiền trả phải là dòng tiền);
 *  - tuỳ chọn "Đã trả ngay X, ngày …" ⇒ sinh một dòng `SUPPLIER_PAY` (đây MỚI là tiền rời quỹ).
 * Phiếu cũ hơn ngày mở sổ ẩn mặc định, bấm nút để hiện.
 */

type Dong = {
  chon: boolean;
  daTraTruoc: number | null; // chỉ phiếu trước D0
  lyDoLech: string;
  traNgay: boolean;
  soTienTraNgay: number | null;
  ngayTraNgay: string;
};

const nhanPhieu = (p: PhieuChoGhiNo) => `#${p.displayId ?? p.uuid.slice(0, 8)}`;

/** Số "đã trả trước" sẽ được ghi cho phiếu theo luật server (`daTraTruocHopLe`), từ trạng thái dòng. */
function daTraTruocDuKien(p: PhieuChoGhiNo, d: Dong): number {
  if (p.truocD0) return d.daTraTruoc ?? p.soNguon ?? 0;
  return p.soNguon ?? 0;
}

/** Gõ KHÁC số Sổ chi phí của phiếu trước D0 (có dòng) ⇒ cần chủ shop + lý do. */
function canLyDoLech(p: PhieuChoGhiNo, d: Dong): boolean {
  return p.truocD0 && p.soNguon !== null && d.daTraTruoc !== null && d.daTraTruoc !== p.soNguon;
}

export function GhiNhanPhieuVaoSoNo({
  phieu,
  mocM,
  laChuShop,
  choPhepSua,
  choPhepTraNgay = true,
}: {
  phieu: readonly PhieuChoGhiNo[];
  mocM: string;
  laChuShop: boolean;
  choPhepSua: boolean;
  /** `false` (trước khi bật): ẩn ô "trả ngay" — tiền mới chỉ ghi được sau mốc bật, hồ sơ phiếu thì được. */
  choPhepTraNgay?: boolean;
}) {
  const router = useRouter();
  const homNay = format(new Date(), "yyyy-MM-dd");
  const [hienCu, setHienCu] = useState(false);
  const [mo, setMo] = useState(false);
  const [dangChay, setDangChay] = useState(false);
  const [dong, setDong] = useState<Record<string, Dong>>(() =>
    Object.fromEntries(
      phieu.map((p) => [
        p.uuid,
        { chon: !p.truocD0, daTraTruoc: null, lyDoLech: "", traNgay: false, soTienTraNgay: null, ngayTraNgay: homNay },
      ]),
    ),
  );

  const soPhieuCu = phieu.filter((p) => p.truocD0).length;
  const hienThi = useMemo(() => phieu.filter((p) => hienCu || !p.truocD0), [phieu, hienCu]);

  function sua(uuid: string, patch: Partial<Dong>) {
    setDong((t) => ({ ...t, [uuid]: { ...t[uuid], ...patch } }));
  }

  // Lỗi chặn nút ghi, theo từng phiếu đang CHỌN (câu hiện ngay dưới dòng).
  function loiCua(p: PhieuChoGhiNo): string | null {
    const d = dong[p.uuid];
    if (canLyDoLech(p, d)) {
      if (!laChuShop) return "Số khác số Sổ chi phí chỉ chủ shop ghi được.";
      if (d.lyDoLech.trim().length < 3) return "Ghi lý do lệch (tối thiểu 3 ký tự).";
    }
    if (daTraTruocDuKien(p, d) > p.soTien) return "Đã trả trước không được lớn hơn tổng phiếu.";
    if (d.traNgay) {
      if (d.soTienTraNgay === null || d.soTienTraNgay <= 0) return "Nhập số tiền đã trả ngay.";
      if (d.ngayTraNgay < mocM || d.ngayTraNgay > homNay) return "Ngày trả phải từ ngày bật theo dõi nợ tới hôm nay.";
    }
    return null;
  }

  const dangChon = phieu.filter((p) => dong[p.uuid]?.chon);
  const coLoi = dangChon.some((p) => loiCua(p) !== null);
  const tongNghiaVu = dangChon.reduce((s, p) => s + p.soTien, 0);
  const tongTraNgay = dangChon.reduce(
    (s, p) => s + (dong[p.uuid].traNgay ? (dong[p.uuid].soTienTraNgay ?? 0) : 0),
    0,
  );

  async function ghi() {
    setDangChay(true);
    let daGhi = 0;
    let daCo = 0;
    const loi: string[] = [];
    try {
      // Tuần tự: mỗi phiếu một transaction + khoá riêng; chạy song song chỉ thêm tranh khoá.
      for (const p of dangChon) {
        const d = dong[p.uuid];
        const res = await ghiNhanPhieuVaoSoNo({
          uuid: p.uuid,
          ...(p.truocD0 && d.daTraTruoc !== null ? { daTraTruoc: d.daTraTruoc } : {}),
          ...(canLyDoLech(p, d) ? { lyDoLech: d.lyDoLech } : {}),
          ...(d.traNgay && d.soTienTraNgay !== null
            ? { daTraNgay: { soTien: d.soTienTraNgay, ngay: new Date(`${d.ngayTraNgay}T00:00:00+07:00`) } }
            : {}),
        });
        if (res.ok) daGhi += 1;
        else if (res.code === "DA_GHI_ROI") daCo += 1;
        else loi.push(`${nhanPhieu(p)}: ${res.error}`);
      }
    } catch {
      loi.push("mất kết nối giữa chừng — tải lại trang để xem phiếu nào đã vào sổ");
    } finally {
      setDangChay(false);
    }
    setMo(false);
    if (daGhi > 0) toast.success(`Đã ghi nhận ${daGhi} phiếu vào sổ nợ.`);
    if (daCo > 0) toast.info(`${daCo} phiếu đã có trong sổ nợ từ trước.`);
    for (const l of loi) toast.error(l);
    router.refresh();
  }

  if (phieu.length === 0) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-card p-6 text-sm text-muted-foreground">
        Không có phiếu nhập nào chờ ghi nhận vào sổ nợ.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2" data-testid="ghi-nhan-phieu">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-lg text-ink">Phiếu nhập chờ ghi nhận vào sổ nợ</h2>
        {soPhieuCu > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setHienCu((v) => !v)}>
            {hienCu ? "Ẩn" : "Hiện"} {soPhieuCu} phiếu cũ hơn ngày mở sổ
          </Button>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-surface-soft text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2" />
              <th className="px-3 py-2 font-medium">Ngày</th>
              <th className="px-3 py-2 font-medium">Phiếu</th>
              <th className="px-3 py-2 font-medium">Nhà cung cấp</th>
              <th className="px-3 py-2 text-right font-medium">Tổng phiếu</th>
              <th className="px-3 py-2 text-right font-medium">Đã trả trước</th>
              <th className="px-3 py-2 font-medium">{choPhepTraNgay ? "Đã trả ngay" : ""}</th>
            </tr>
          </thead>
          <tbody>
            {hienThi.map((p) => {
              const d = dong[p.uuid];
              const loi = d.chon ? loiCua(p) : null;
              return (
                <tr key={p.uuid} className="border-t border-hairline align-top">
                  <td className="px-3 py-2">
                    <Checkbox
                      disabled={!choPhepSua}
                      aria-label={`Chọn phiếu ${nhanPhieu(p)}`}
                      checked={d.chon}
                      onCheckedChange={() => sua(p.uuid, { chon: !d.chon })}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink">{format(p.ngay, "dd/MM/yyyy")}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink">
                    {nhanPhieu(p)}
                    {p.lechLuoiKiem && (
                      <span
                        className="ml-2 rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 text-xs text-ink"
                        title="Pancake khai tổng khác với tổng các dòng hàng — kiểm lại bên Pancake"
                      >
                        lệch
                      </span>
                    )}
                  </td>
                  <td className="max-w-[160px] truncate px-3 py-2 text-muted-foreground">{p.nhaCungCap ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{formatVnd(p.soTien)}</td>
                  <td className="px-3 py-2 text-right">
                    {p.truocD0 ? (
                      <>
                        <Input
                          inputMode="numeric"
                          aria-label={`Đã trả trước phiếu ${nhanPhieu(p)}`}
                          disabled={!choPhepSua || !d.chon}
                          className="ml-auto w-32 text-right tabular-nums"
                          placeholder={formatAmountInput(p.soNguon ?? 0) || "0"}
                          value={d.daTraTruoc === null ? "" : formatAmountInput(d.daTraTruoc) || "0"}
                          onChange={(e) =>
                            sua(p.uuid, {
                              daTraTruoc: e.target.value.replace(/\D/g, "") === "" ? null : parseAmountInput(e.target.value),
                            })
                          }
                        />
                        {p.soNguon !== null && (
                          <p className="mt-1 text-xs text-muted-foreground">Sổ chi phí: {formatVnd(p.soNguon)}</p>
                        )}
                        {d.chon && canLyDoLech(p, d) && laChuShop && (
                          <Input
                            aria-label={`Lý do lệch phiếu ${nhanPhieu(p)}`}
                            placeholder="Lý do lệch so với Sổ chi phí"
                            maxLength={300}
                            className="mt-1 w-56"
                            value={d.lyDoLech}
                            onChange={(e) => sua(p.uuid, { lyDoLech: e.target.value })}
                          />
                        )}
                      </>
                    ) : (
                      <span className="tabular-nums text-muted-foreground">
                        {formatVnd(p.soNguon ?? 0)}
                        {p.soNguon !== null && <span className="block text-xs">theo Sổ chi phí</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {choPhepTraNgay && (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox
                        disabled={!choPhepSua || !d.chon}
                        aria-label={`Đã trả ngay phiếu ${nhanPhieu(p)}`}
                        checked={d.traNgay}
                        onCheckedChange={() =>
                          sua(p.uuid, {
                            traNgay: !d.traNgay,
                            soTienTraNgay: d.soTienTraNgay ?? Math.max(0, p.soTien - daTraTruocDuKien(p, d)),
                          })
                        }
                      />
                      trả ngay
                    </label>
                    )}
                    {choPhepTraNgay && d.traNgay && (
                      <div className="mt-1 flex flex-col gap-1">
                        <Input
                          inputMode="numeric"
                          aria-label={`Số tiền trả ngay phiếu ${nhanPhieu(p)}`}
                          className="w-32 text-right tabular-nums"
                          value={formatAmountInput(d.soTienTraNgay ?? 0)}
                          onChange={(e) => sua(p.uuid, { soTienTraNgay: parseAmountInput(e.target.value) })}
                        />
                        <Input
                          type="date"
                          aria-label={`Ngày trả ngay phiếu ${nhanPhieu(p)}`}
                          className="w-36"
                          min={mocM}
                          max={homNay}
                          value={d.ngayTraNgay}
                          onChange={(e) => sua(p.uuid, { ngayTraNgay: e.target.value })}
                        />
                      </div>
                    )}
                    {loi && <p className="mt-1 max-w-[240px] text-xs text-error">{loi}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Tổng phiếu lấy thẳng từ Pancake (không sửa ở đây). Phần đã trả là thông tin riêng: Pancake không lưu số
        bạn đã trả nhà cung cấp.
      </p>

      {choPhepSua && (
        <>
          <section className="flex flex-col gap-2 rounded-lg border border-hairline bg-surface-card p-4">
            <h2 className="font-serif text-lg text-ink">Ảnh hưởng nếu ghi</h2>
            <p className="text-sm text-ink">
              Đang chọn <strong>{dangChon.length.toLocaleString("vi-VN")}</strong> phiếu, tổng phiếu{" "}
              <strong>{formatVnd(tongNghiaVu)}</strong>.
            </p>
            <p className="text-sm text-ink" data-testid="anh-huong-khong-doi-quy">
              <strong>KHÔNG đổi quỹ — chỉ ghi nghĩa vụ.</strong> Quỹ chỉ giảm khi bạn ghi tiền trả thật
              {tongTraNgay > 0 ? (
                <>
                  : lần này có <strong>{formatVnd(tongTraNgay)}</strong> &quot;trả ngay&quot; nên quỹ giảm đúng số đó.
                </>
              ) : (
                "."
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-ink">Lãi/Lỗ KHÔNG đổi</strong> — tiền hàng chỉ vào Lãi/Lỗ dưới dạng giá vốn
              khi món hàng được bán ra.
            </p>
          </section>

          <Dialog open={mo} onOpenChange={setMo}>
            <DialogTrigger
              render={
                <Button className="self-start" disabled={dangChon.length === 0 || coLoi}>
                  Ghi nhận {dangChon.length.toLocaleString("vi-VN")} phiếu vào sổ nợ
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Xác nhận ghi nhận vào sổ nợ</DialogTitle>
                <DialogDescription>Mỗi phiếu thành một hồ sơ nghĩa vụ trả nhà cung cấp.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2 text-sm">
                <p>
                  Ghi nhận <strong>{dangChon.length.toLocaleString("vi-VN")}</strong> phiếu, tổng nghĩa vụ{" "}
                  <strong>{formatVnd(tongNghiaVu)}</strong>.
                </p>
                <p>
                  {tongTraNgay > 0
                    ? `Quỹ giảm ${formatVnd(tongTraNgay)} (phần trả ngay).`
                    : "Quỹ không đổi."}{" "}
                  Lãi/Lỗ không đổi.
                </p>
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Huỷ</Button>} />
                <Button onClick={ghi} disabled={dangChay}>
                  {dangChay ? "Đang ghi…" : "Ghi vào sổ nợ"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  );
}
