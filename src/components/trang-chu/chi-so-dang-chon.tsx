"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { BieuDoTheoNgay, TEN_CHI_SO } from "@/components/trang-chu/bieu-do-theo-ngay";
import { MAU_CHI_SO } from "@/components/trang-chu/mau-trang-chu";
import { TheKhoi } from "@/components/trang-chu/the-khoi";
import { TheSo } from "@/components/trang-chu/the-so";
import { formatPercent, formatSoDem, formatVnd } from "@/lib/format";
import type { ChiSoBieuDo, DiemBieuDo, DuLieuTheVaBieuDo } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";
import { cn } from "@/lib/utils";

type NguCanhChiSo = { chiSo: ChiSoBieuDo; setChiSo: (k: ChiSoBieuDo) => void };

const NguCanh = createContext<NguCanhChiSo | null>(null);

/** Chỉ số được phép chọn: thiếu quyền giá vốn ⇒ CHỈ doanh số/đơn (chi phí, lợi nhuận bị từ chối). */
const CHI_SO_NHANH_CHE: ReadonlySet<ChiSoBieuDo> = new Set(["doanhSo", "donHang"]);

/**
 * Giữ chỉ số đang chọn (mặc định Doanh số) cho thẻ số + biểu đồ ngày dùng chung. `coQuyenGiaVon=false` ⇒
 * `setChiSo("chiPhi" | "loiNhuan")` bị bỏ qua, nên dù ai gọi thẳng cũng không đổi được sang số nhạy cảm.
 */
export function ChiSoProvider(props: { coQuyenGiaVon: boolean; children: ReactNode }) {
  const { coQuyenGiaVon, children } = props;
  const [chiSo, datChiSo] = useState<ChiSoBieuDo>("doanhSo");
  const setChiSo = useCallback(
    (k: ChiSoBieuDo) => {
      if (!coQuyenGiaVon && !CHI_SO_NHANH_CHE.has(k)) return;
      datChiSo(k);
    },
    [coQuyenGiaVon],
  );
  const giaTri = useMemo(() => ({ chiSo, setChiSo }), [chiSo, setChiSo]);
  return <NguCanh.Provider value={giaTri}>{children}</NguCanh.Provider>;
}

export function useChiSoDangChon(): NguCanhChiSo {
  const ngu = useContext(NguCanh);
  if (!ngu) throw new Error("useChiSoDangChon phải nằm trong <ChiSoProvider>");
  return ngu;
}

/** Dãy giá trị một chỉ số: kỳ này đủ mọi ngày; kỳ trước chỉ phần có (ngắn hơn ⇒ dừng sớm), null khi không có. */
function duongNhoCua<G extends Record<string, number>>(bieuDo: DiemBieuDo<G>[], k: string) {
  const truoc = bieuDo.flatMap((d) => (d.kyTruoc ? [d.kyTruoc[k]] : []));
  return { hienTai: bieuDo.map((d) => d.hienTai[k]), kyTruoc: truoc.length > 0 ? truoc : null };
}

/** Lưới thẻ số; nhánh che CHỈ Doanh số + Đơn hợp lệ (2 cột). */
export function HangTheSo(props: { du: DuLieuTheVaBieuDo }) {
  const { du } = props;
  const { chiSo, setChiSo } = useChiSoDangChon();
  const chung = (k: ChiSoBieuDo) => ({
    mau: MAU_CHI_SO[k],
    dangChon: chiSo === k,
    onChon: () => setChiSo(k),
    duongNho: duongNhoCua(du.bieuDo, k),
  });

  const doanhSo = (
    <TheSo
      key="doanhSo"
      nhan={TEN_CHI_SO.doanhSo}
      giaTri={formatVnd(du.the.doanhSo.hienTai)}
      soSanh={du.the.doanhSo}
      tangLaTot
      dongPhu={du.the.tbMoiDon === null ? "TB —" : `TB ${formatVnd(du.the.tbMoiDon)}/đơn`}
      {...chung("doanhSo")}
    />
  );
  const donHang = (
    <TheSo
      key="donHang"
      nhan={TEN_CHI_SO.donHang}
      giaTri={`${formatSoDem(du.the.donHang.hienTai)} đơn`}
      soSanh={du.the.donHang}
      tangLaTot
      dongPhu={`Hoàn / hủy ${du.the.tyLeHoanHuy === null ? "—" : formatPercent(du.the.tyLeHoanHuy)}`}
      {...chung("donHang")}
    />
  );

  if (!du.coQuyenGiaVon) {
    return <div className="grid grid-cols-2 gap-3">{[doanhSo, donHang]}</div>;
  }
  const { the } = du;
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4")}>
      {doanhSo}
      <TheSo
        nhan={TEN_CHI_SO.chiPhi}
        giaTri={formatVnd(the.chiPhi.hienTai)}
        soSanh={the.chiPhi}
        tangLaTot={false}
        dongPhu={`Quảng cáo ${formatVnd(the.quangCao)}`}
        {...chung("chiPhi")}
      />
      <TheSo
        nhan={TEN_CHI_SO.loiNhuan}
        giaTri={formatVnd(the.loiNhuan.hienTai)}
        giaTriAm={the.loiNhuan.hienTai < 0}
        giaTriLoiNhuan={the.loiNhuan.hienTai > 0}
        soSanh={the.loiNhuan}
        tangLaTot
        dongPhu={`Biên lãi ${the.bienLai === null ? "—" : formatPercent(the.bienLai)}`}
        {...chung("loiNhuan")}
      />
      {donHang}
    </div>
  );
}

/** Khối biểu đồ ngày của chỉ số đang chọn. */
export function KhoiBieuDoTheoNgay(props: { du: DuLieuTheVaBieuDo }) {
  const { du } = props;
  const { chiSo } = useChiSoDangChon();
  const tieuDe = `${TEN_CHI_SO[chiSo]} theo ngày`;
  return (
    <TheKhoi tieuDe={tieuDe} data-testid="khoi-bieu-do-theo-ngay">
      {/* Điểm bám cho test/E2E: TheKhoi không nhận testid trên tiêu đề. Ẩn khỏi trình đọc màn hình vì h2 đã đọc. */}
      <span data-testid="tieu-de-bieu-do" aria-hidden="true" className="sr-only">
        {tieuDe}
      </span>
      <BieuDoTheoNgay diem={du.bieuDo} chiSo={chiSo} motNgay={du.motNgay} nhanKySoSanh={du.nhanKySoSanh} />
    </TheKhoi>
  );
}
