"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  boQuaLechDaGiaiThich,
  capNhatDaTraTruoc,
  capNhatTongPhieu,
  danhDauHuyPhieu,
} from "@/lib/actions/phieu-nhap-no";
import type { ActionResult } from "@/lib/actions/action-result";
import { formatVnd } from "@/lib/format";
import type { CanhBaoHauKiem } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

/**
 * Khối HẬU KIỂM phiếu đã ghi nhận vào sổ nợ — ba loại lệch với nguồn (Pancake đổi tổng · Pancake huỷ ·
 * "đã trả trước" lệch Sổ chi phí). CHỈ cảnh báo; mỗi nút là MỘT quyết định chủ shop bấm sau khi đọc:
 *  - Cập nhật tổng (`sua`): sổ nợ theo số Pancake đang khai;
 *  - Đánh dấu huỷ (CHỈ chủ shop): nghĩa vụ về 0, tiền đã trả giữ nguyên (hiện "cần thu hồi");
 *  - Cập nhật đã trả trước (`sua`): theo số Sổ chi phí hiện tại;
 *  - Đã giải thích (CHỈ chủ shop, bắt buộc ghi lý do): giữ số sổ nợ, ẩn cảnh báo chừng nào Sổ chi phí còn
 *    đúng số này.
 * `DANH_SACH_DA_DOI` (Pancake vừa đổi tiếp) ⇒ tải lại để thấy số mới.
 */
export function HauKiemPhieuKhoi({
  canhBao,
  choPhepSua,
  laChuShop,
}: {
  canhBao: readonly CanhBaoHauKiem[];
  choPhepSua: boolean;
  laChuShop: boolean;
}) {
  const router = useRouter();
  const [dangChay, setDangChay] = useState<string | null>(null);
  const [moGiaiThich, setMoGiaiThich] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (canhBao.length === 0) return null;

  async function chay(khoa: string, loiChung: string, goi: () => Promise<ActionResult<unknown>>, thanhCong: string) {
    setDangChay(khoa);
    try {
      const res = await goi();
      if (!res.ok) {
        toast.error(res.error);
        if (res.code === "DANH_SACH_DA_DOI") router.refresh();
        return;
      }
      toast.success(thanhCong);
      setMoGiaiThich(null);
      setNote("");
      router.refresh();
    } catch {
      toast.error(loiChung);
    } finally {
      setDangChay(null);
    }
  }

  const loiMang = "Thao tác thất bại — kiểm tra kết nối";

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4" data-testid="hau-kiem-phieu">
      <p className="text-sm font-semibold text-ink">Phiếu đã ghi nhận cần kiểm lại ({canhBao.length})</p>
      <ul className="flex flex-col gap-3">
        {canhBao.map((c) => {
          const khoa = `${c.phieuNhapId}:${c.loai}`;
          const dangBam = dangChay === khoa;
          return (
            <li key={khoa} className="flex flex-col gap-1.5 text-sm text-ink">
              <p>{c.chiTiet}</p>
              {choPhepSua && (
                <div className="flex flex-wrap items-center gap-2">
                  {c.loai === "DOI_TONG" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={dangBam}
                      onClick={() =>
                        chay(
                          khoa,
                          loiMang,
                          () => capNhatTongPhieu({ phieuNhapId: c.phieuNhapId, tongTienMoi: c.soMoi }),
                          `Đã cập nhật tổng phiếu ${c.maPhieu} thành ${formatVnd(c.soMoi)}`,
                        )
                      }
                    >
                      Cập nhật tổng
                    </Button>
                  )}
                  {c.loai === "DA_HUY_PANCAKE" &&
                    (laChuShop ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={dangBam}
                        onClick={() =>
                          chay(
                            khoa,
                            loiMang,
                            () => danhDauHuyPhieu({ phieuNhapId: c.phieuNhapId }),
                            `Đã đánh dấu huỷ phiếu ${c.maPhieu}`,
                          )
                        }
                      >
                        Đánh dấu huỷ
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Chỉ chủ shop đánh dấu huỷ được.</span>
                    ))}
                  {c.loai === "LECH_DA_TRA_TRUOC" && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={dangBam}
                        onClick={() =>
                          chay(
                            khoa,
                            loiMang,
                            () => capNhatDaTraTruoc({ phieuNhapId: c.phieuNhapId, daTraTruoc: c.soMoi }),
                            `Đã cập nhật đã trả trước phiếu ${c.maPhieu} thành ${formatVnd(c.soMoi)}`,
                          )
                        }
                      >
                        Cập nhật đã trả trước
                      </Button>
                      {laChuShop && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={dangBam}
                          onClick={() => setMoGiaiThich(moGiaiThich === khoa ? null : khoa)}
                        >
                          Đã giải thích
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
              {moGiaiThich === khoa && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Lý do lệch phiếu ${c.maPhieu}`}
                    placeholder="Lý do lệch (bắt buộc)"
                    maxLength={200}
                    className="w-72"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={dangBam || note.trim() === ""}
                    onClick={() =>
                      chay(
                        khoa,
                        loiMang,
                        () => boQuaLechDaGiaiThich({ phieuNhapId: c.phieuNhapId, note }),
                        `Đã ghi lý do lệch phiếu ${c.maPhieu}`,
                      )
                    }
                  >
                    Lưu lý do
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
