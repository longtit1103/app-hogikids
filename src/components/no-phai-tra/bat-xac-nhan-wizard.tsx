"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { docChenhLechTaiM, xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { formatVnd } from "@/lib/format";
import { parseSignedAmountInput } from "@/lib/format-amount-input";
import type { KetQuaDocChenhLech } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import { goiYDieuChinh, tacDongDieuChinh, type DongDieuChinh } from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

import { BuocDoiChieu, type LuaChonManHinh } from "./bat-buoc-doi-chieu";
import {
  buoc1HopLe,
  BuocKhaiTheVi,
  khaiTheMacDinh,
  type KhaiThe,
  type TheChoBat,
  type ViChoBat,
} from "./bat-buoc-khai-the-vi";
import { NhapHangSauMHuongDan, type NhapHangSauMChoManHinh } from "./nhap-hang-sau-m-huong-dan";

/**
 * Màn XÁC NHẬN bật theo dõi nợ phải trả (chỉ chủ shop, chỉ khi hôm nay ≥ ngày bật) — 3 bước trên một
 * trang: (1) khai dư nợ thẻ + số dư ví cuối ngày trước ngày bật, (2) đối chiếu tiền thật ⇒ chọn điều chỉnh
 * quỹ, (3) xác nhận. Một `yeuCauId` cho cả lượt mở màn: mất phản hồi rồi bấm lại cùng nội dung ⇒ server trả
 * "đã ghi rồi", không bật hai lần. Đổi số ở bước 1/ô ngân hàng sau khi đã tính ⇒ kết quả bước 2 bị bỏ, phải
 * tính lại (điều chỉnh luôn khớp đúng số đang hiện).
 */
export function XacNhanBatWizard({
  mocM,
  nhanM,
  ngayTruocM,
  nhanTruocM,
  the,
  vi,
  loiDieuKien,
  thieuHoSoVi = null,
  nhapHangSauM = null,
}: {
  mocM: string;
  nhanM: string;
  ngayTruocM: string;
  nhanTruocM: string;
  the: readonly TheChoBat[];
  vi: readonly ViChoBat[];
  /** Điều kiện tiên quyết chưa đạt (server đọc) — còn câu nào thì không cho xác nhận. */
  loiDieuKien: readonly string[];
  /**
   * Câu lý do "thiếu hồ sơ ví trả trước" (null = đủ). KHÔNG chặn cứng: chủ shop đánh dấu xác nhận ví Shopee
   * chưa theo dõi (nạp từ ví bán hàng / chưa muốn theo dõi) thì được bật — server kiểm lại cờ này.
   */
  thieuHoSoVi?: string | null;
  /**
   * Còn chi phí Nhập hàng ghi từ ngày bật trở đi (null = không còn) — CHẶN như `loiDieuKien`, nhưng hiện danh
   * sách dòng kèm link Sổ chi phí + ba trường hợp xử lý thay cho một câu dài.
   */
  nhapHangSauM?: NhapHangSauMChoManHinh | null;
}) {
  const router = useRouter();
  const [yeuCauId] = useState(() => crypto.randomUUID());
  const [khai, setKhai] = useState<Record<string, KhaiThe>>(() =>
    Object.fromEntries(the.map((t) => [t.id, khaiTheMacDinh(t)]))
  );
  const [soDuVi, setSoDuVi] = useState<Record<string, number | null>>(() => Object.fromEntries(vi.map((v) => [v.id, null])));
  const [bankRaw, setBankRaw] = useState("");
  const [tienMat, setTienMat] = useState(0);
  const [ketQua, setKetQua] = useState<KetQuaDocChenhLech | null>(null);
  const [luaChon, setLuaChon] = useState<LuaChonManHinh>("giai-thich-duoc");
  const [dieuChinh, setDieuChinh] = useState<DongDieuChinh[]>([]);
  const [dangTinh, setDangTinh] = useState(false);
  const [dongY, setDongY] = useState(false);
  const [dangBat, setDangBat] = useState(false);
  const [xacNhanViChuaTheoDoi, setXacNhanViChuaTheoDoi] = useState(false);

  const b1 = buoc1HopLe(the, khai, vi, soDuVi);
  const boKetQua = () => {
    setKetQua(null);
    setDieuChinh([]);
    setDongY(false);
  };

  async function tinh() {
    setDangTinh(true);
    try {
      const res = await docChenhLechTaiM({
        mocM,
        soDuBank: parseSignedAmountInput(bankRaw),
        tienMat,
        the: the.map((t) => ({ cardId: t.id, duNo: khai[t.id].duNo ?? 0 })),
        viAds: vi.map((v) => ({ viAdsId: v.id, soDu: soDuVi[v.id] ?? 0 })),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setKetQua(res.data);
      setLuaChon("giai-thich-duoc");
      setDieuChinh(goiYDieuChinh(res.data, "giai-thich-duoc", nhanM));
      setDongY(false);
    } catch {
      toast.error("Không tính được — kiểm tra kết nối");
    } finally {
      setDangTinh(false);
    }
  }

  function doiLuaChon(l: LuaChonManHinh) {
    setLuaChon(l);
    if (ketQua && l !== "tu-go") setDieuChinh(goiYDieuChinh(ketQua, l, nhanM));
  }

  const dongGui = useMemo(() => dieuChinh.filter((d) => d.soTien > 0), [dieuChinh]);
  const thieuMoTa = dongGui.some((d) => d.moTa.trim() === "");
  const tacDong = tacDongDieuChinh(dongGui);
  const viDaXong = thieuHoSoVi === null || xacNhanViChuaTheoDoi;
  const coTheBat = b1 && ketQua !== null && !thieuMoTa && dongY && loiDieuKien.length === 0 && nhapHangSauM === null && viDaXong && !dangBat;

  async function bat() {
    setDangBat(true);
    try {
      const res = await xacNhanBatNoPhaiTra({
        yeuCauId,
        mocM,
        the: the.map((t) => {
          const k = khai[t.id];
          return {
            cardId: t.id,
            duNoCuoiMTru1: k.duNo ?? 0,
            saoKeCuoi: k.coSaoKe
              ? { ngayChot: k.ngayChot, hanTra: k.hanTra, soDu: k.soDuSaoKe ?? 0, daTraTruocMoSo: k.daTraTruoc }
              : null,
          };
        }),
        viAds: vi.map((v) => ({ viAdsId: v.id, soDuNeo: soDuVi[v.id] ?? 0 })),
        xacNhanViShopeeChuaTheoDoi: thieuHoSoVi !== null && xacNhanViChuaTheoDoi,
        dieuChinh: dongGui.map((d) => ({ ...d, moTa: d.moTa.trim() })),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.code === "DA_GHI_ROI" ? "Đã bật từ trước — không ghi thêm." : `Đã bật theo dõi nợ phải trả từ ${nhanM}`);
      router.refresh();
    } catch {
      toast.error("Bật thất bại — kiểm tra kết nối rồi bấm lại (an toàn, không ghi trùng)");
    } finally {
      setDangBat(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {(loiDieuKien.length > 0 || nhapHangSauM !== null) && (
        <div className="flex flex-col gap-2 rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-ink" data-testid="bat-loi-dieu-kien">
          <p className="font-medium">Chưa bật được — xử lý ở tab Chuẩn bị:</p>
          {loiDieuKien.length > 0 && (
            <ul className="list-disc pl-5">
              {loiDieuKien.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {nhapHangSauM !== null && <NhapHangSauMHuongDan duLieu={nhapHangSauM} />}
        </div>
      )}

      {thieuHoSoVi !== null && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-ink" data-testid="bat-vi-chua-theo-doi">
          <p>{thieuHoSoVi}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={xacNhanViChuaTheoDoi}
              onChange={(e) => setXacNhanViChuaTheoDoi(e.target.checked)}
            />
            <span>
              Shopee Ads nạp từ ví bán hàng hoặc chưa muốn theo dõi ví — chi ads Shopee tiếp tục trừ quỹ theo ngày chạy
              như nay (không phồng quỹ vì không có hồ sơ ví)
            </span>
          </label>
        </div>
      )}

      <BuocKhaiTheVi
        the={the}
        khai={khai}
        onKhai={(id, k) => {
          setKhai((cu) => ({ ...cu, [id]: k }));
          boKetQua();
        }}
        vi={vi}
        soDuVi={soDuVi}
        onSoDuVi={(id, x) => {
          setSoDuVi((cu) => ({ ...cu, [id]: x }));
          boKetQua();
        }}
        ngayTruocM={ngayTruocM}
        nhanTruocM={nhanTruocM}
      />

      <BuocDoiChieu
        bankRaw={bankRaw}
        onBankRaw={(s) => {
          setBankRaw(s);
          boKetQua();
        }}
        tienMat={tienMat}
        onTienMat={(n) => {
          setTienMat(n);
          boKetQua();
        }}
        coTheTinh={b1}
        dangTinh={dangTinh}
        onTinh={tinh}
        ketQua={ketQua}
        luaChon={luaChon}
        onLuaChon={doiLuaChon}
        dieuChinh={dieuChinh}
        onDieuChinh={setDieuChinh}
        nhanTruocM={nhanTruocM}
      />

      <section className="flex flex-col gap-3 rounded-xl border border-hairline p-4" aria-labelledby="buoc-3">
        <h2 id="buoc-3" className="font-serif text-lg text-ink">
          Bước 3 · Xác nhận bật từ {nhanM}
        </h2>
        {ketQua === null ? (
          <p className="text-sm text-muted-foreground">Tính chênh lệch ở bước 2 trước.</p>
        ) : (
          <div className="flex flex-col gap-1 text-sm" data-testid="bat-tom-tat">
            <p className="text-muted-foreground">
              Quỹ của app cuối {nhanTruocM}: <span className="tabular-nums text-ink">{formatVnd(ketQua.quyApp)}</span>
            </p>
            <p className="text-muted-foreground">
              Điều chỉnh ngày {nhanM} ({dongGui.length} dòng):{" "}
              <span className="tabular-nums text-ink">
                {tacDong >= 0 ? "+" : "−"}
                {formatVnd(Math.abs(tacDong))}
              </span>
            </p>
            {thieuMoTa && <p className="text-xs text-error">Mỗi dòng điều chỉnh phải có mô tả.</p>}
          </div>
        )}
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          <li>Bật MỘT lần, không tắt lại được. Từ ngày bật, quỹ chỉ giảm khi bạn THẬT trả thẻ / trả nhà cung cấp / nạp ví.</li>
          <li>Thẻ đang có nợ mà chưa có hồ sơ: thêm ở tab Chuẩn bị TRƯỚC — thẻ thêm sau khi bật chỉ khai dư nợ 0.</li>
          <li>Lãi/Lỗ không đổi.</li>
        </ul>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={dongY} disabled={ketQua === null} onChange={(e) => setDongY(e.target.checked)} />
          Tôi đã kiểm số và hiểu đây là bước một lần
        </label>
        <div>
          <Button type="button" disabled={!coTheBat} onClick={bat}>
            {dangBat ? "Đang bật…" : "Xác nhận bật theo dõi nợ phải trả"}
          </Button>
        </div>
      </section>
    </div>
  );
}
