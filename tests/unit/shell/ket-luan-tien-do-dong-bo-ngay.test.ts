import { describe, expect, it } from "vitest";

import {
  ketLuanTienDo,
  mocBamHopLe,
  type SoLieuTienDoDongBoNgay,
  thongDiepKetLuan,
  TRAN_CHO_PHAN_HOI_MS,
  TRAN_DUNG_IM_MS,
  TRAN_MAY_KHACH_MS,
  TRAN_MOC_QUA_KHU_MS,
  TRAN_MOC_TUONG_LAI_MS,
  TRAN_TONG_MS,
} from "@/lib/ingest/tien-do-dong-bo-ngay";
import { cauLoiKeo, docTomTatLoiKeo } from "@/lib/ingest/tom-tat-loi-keo-dong-bo-ngay";

/**
 * Luật "lượt Đồng bộ ngay đã xong chưa" của nút bấm — hàm thuần, khoá từng nhánh.
 *
 * Lỗi cũ phải canh: nút báo "Đồng bộ xong" ở dòng SyncLog ĐẦU TIÊN (một trang products) trong khi
 * phiếu nhập/đơn/dải nhắc việc còn chưa về. Nay chỉ dòng BƯỚC CUỐI mới là "xong"; workflow chết giữa
 * chừng phải có lối ra; bước cuối lỗi KHÔNG được báo thành công.
 */

const MOC = Date.parse("2026-10-07T10:00:00.000Z");
const iso = (msSauMoc: number) => new Date(MOC + msSauMoc).toISOString();

function soLieu(p: Partial<SoLieuTienDoDongBoNgay> & { sau: number }): SoLieuTienDoDongBoNgay {
  const { sau, ...rest } = p;
  return {
    buocCuoi: null,
    soLuot: 0,
    soLuotLoi: 0,
    coLuotDangChay: false,
    hoatDongCuoi: null,
    mocBam: iso(0),
    bayGio: iso(sau),
    ...rest,
  };
}

describe("ketLuanTienDo", () => {
  it("mới có dòng trang đầu (đã OK) ⇒ CHƯA xong — đúng lỗi cũ", () => {
    const s = soLieu({ sau: 6_000, soLuot: 1, hoatDongCuoi: iso(3_000) });
    expect(ketLuanTienDo(s)).toEqual({ loai: "dang-chay" });
    expect(thongDiepKetLuan(ketLuanTienDo(s))).toBeNull();
  });

  it("bước cuối OK ⇒ xong; kèm số lượt kéo lỗi nếu có", () => {
    expect(ketLuanTienDo(soLieu({ sau: 60_000, soLuot: 30, buocCuoi: { status: "OK", error: null } }))).toEqual({
      loai: "xong",
      soLuotLoi: 0,
    });
    const coLoi = ketLuanTienDo(
      soLieu({ sau: 60_000, soLuot: 30, soLuotLoi: 2, buocCuoi: { status: "OK", error: null } }),
    );
    expect(coLoi).toEqual({ loai: "xong", soLuotLoi: 2 });
    expect(thongDiepKetLuan(coLoi)?.muc).toBe("canh-bao");
  });

  it("bước cuối ERROR ⇒ báo LỖI, không bao giờ là 'xong'", () => {
    const k = ketLuanTienDo(soLieu({ sau: 60_000, soLuot: 30, buocCuoi: { status: "ERROR", error: "Bronze hỏng" } }));
    expect(k.loai).toBe("loi-buoc-cuoi");
    const td = thongDiepKetLuan(k);
    expect(td?.muc).toBe("loi");
    expect(td?.noiDung).toContain("Bronze hỏng");
    expect(td?.noiDung).not.toBe("Đồng bộ xong");
  });

  it("bước cuối RUNNING ⇒ còn chạy dù im lâu (đếm có thể chậm)", () => {
    const s = soLieu({
      sau: TRAN_DUNG_IM_MS * 2,
      soLuot: 30,
      hoatDongCuoi: iso(1_000),
      buocCuoi: { status: "RUNNING", error: null },
    });
    expect(ketLuanTienDo(s)).toEqual({ loai: "dang-chay" });
  });

  it("chưa dòng nào: trong trần chờ ⇒ chạy; quá trần ⇒ n8n chưa phản hồi", () => {
    expect(ketLuanTienDo(soLieu({ sau: TRAN_CHO_PHAN_HOI_MS - 1 }))).toEqual({ loai: "dang-chay" });
    expect(ketLuanTienDo(soLieu({ sau: TRAN_CHO_PHAN_HOI_MS + 1 }))).toEqual({ loai: "khong-phan-hoi" });
  });

  it("có dòng nhưng im quá trần, không RUNNING, chưa tới bước cuối ⇒ dừng giữa chừng (lối ra)", () => {
    const s = soLieu({ sau: 10_000 + TRAN_DUNG_IM_MS + 1, soLuot: 12, soLuotLoi: 3, hoatDongCuoi: iso(10_000) });
    const k = ketLuanTienDo(s);
    expect(k).toEqual({ loai: "dung-giua-chung", soLuot: 12, soLuotLoi: 3 });
    expect(thongDiepKetLuan(k)?.muc).toBe("loi");
  });

  it("có dòng, im CHƯA quá trần ⇒ còn chạy", () => {
    const s = soLieu({ sau: 10_000 + TRAN_DUNG_IM_MS - 1, soLuot: 12, hoatDongCuoi: iso(10_000) });
    expect(ketLuanTienDo(s)).toEqual({ loai: "dang-chay" });
  });

  it("còn trang RUNNING ⇒ chưa coi là chết dù mốc cũ", () => {
    const s = soLieu({ sau: TRAN_DUNG_IM_MS * 2, soLuot: 5, coLuotDangChay: true, hoatDongCuoi: iso(1_000) });
    expect(ketLuanTienDo(s)).toEqual({ loai: "dang-chay" });
  });

  it("quá trần tổng ⇒ ngừng theo dõi kể cả khi còn RUNNING treo", () => {
    const s = soLieu({ sau: TRAN_TONG_MS + 1, soLuot: 5, coLuotDangChay: true, hoatDongCuoi: iso(TRAN_TONG_MS) });
    const k = ketLuanTienDo(s);
    expect(k).toEqual({ loai: "qua-tran", soLuot: 5 });
    expect(thongDiepKetLuan(k)?.muc).toBe("loi");
  });

  it("bước cuối đã kết thúc thắng mọi trần thời gian (poll muộn vẫn báo đúng)", () => {
    const s = soLieu({ sau: TRAN_TONG_MS * 2, soLuot: 30, buocCuoi: { status: "OK", error: null } });
    expect(ketLuanTienDo(s)).toEqual({ loai: "xong", soLuotLoi: 0 });
  });
});

describe("trần thời gian — GHIM giá trị tuyệt đối", () => {
  // Các test trên tính mốc TƯƠNG ĐỐI theo hằng ⇒ hằng tụt (vd im 3' → 5s) mà vẫn xanh. Ghim số tuyệt
  // đối: im 5s thì gần như mọi lượt bị báo "dừng giữa chừng" (GET Pancake + nghỉ giữa hai trang).
  it("chưa dòng 2' · im 3' · tổng 15' · lưới máy khách 16' · mốc quá khứ 20' · tương lai 60s", () => {
    expect(TRAN_CHO_PHAN_HOI_MS).toBe(120_000);
    expect(TRAN_DUNG_IM_MS).toBe(180_000);
    expect(TRAN_TONG_MS).toBe(15 * 60_000);
    expect(TRAN_MAY_KHACH_MS).toBe(16 * 60_000);
    expect(TRAN_MOC_QUA_KHU_MS).toBe(20 * 60_000);
    expect(TRAN_MOC_TUONG_LAI_MS).toBe(60_000);
  });

  it("chưa dòng nào sau 60s ⇒ VẪN đang chạy (n8n có thể xếp hàng)", () => {
    expect(ketLuanTienDo(soLieu({ sau: 60_000 }))).toEqual({ loai: "dang-chay" });
  });

  it("im 60s, không RUNNING, chưa tới bước cuối ⇒ VẪN đang chạy", () => {
    expect(ketLuanTienDo(soLieu({ sau: 70_000, soLuot: 8, hoatDongCuoi: iso(10_000) }))).toEqual({
      loai: "dang-chay",
    });
  });
});

describe("mocBamHopLe — kẹp mốc máy khách gửi lại", () => {
  it("trong dải ⇒ hợp lệ (kể cả đúng biên)", () => {
    expect(mocBamHopLe(MOC, MOC)).toBe(true);
    expect(mocBamHopLe(MOC - TRAN_MOC_QUA_KHU_MS, MOC)).toBe(true);
    expect(mocBamHopLe(MOC + TRAN_MOC_TUONG_LAI_MS, MOC)).toBe(true);
  });

  it("cũ quá / tương lai quá / NaN ⇒ từ chối", () => {
    expect(mocBamHopLe(MOC - TRAN_MOC_QUA_KHU_MS - 1, MOC)).toBe(false);
    expect(mocBamHopLe(MOC + TRAN_MOC_TUONG_LAI_MS + 1, MOC)).toBe(false);
    expect(mocBamHopLe(0, MOC)).toBe(false); // "1970-01-01" ⇒ quét cả bảng
    expect(mocBamHopLe(Number.NaN, MOC)).toBe(false);
  });
});

describe("lỗi KÉO Pancake báo kèm bước cuối", () => {
  it("bước cuối ERROR do lỗi kéo purchases ⇒ báo LỖI nêu purchases/kho, không bao giờ 'xong'", () => {
    const loi = cauLoiKeo(
      docTomTatLoiKeo(
        JSON.stringify({
          soLoiKeo: 1,
          loiKeo: [{ scope: "CA_STREAM_BI_BO", stream: "purchases", shop: "kho", lyDo: "429" }],
        }),
      ),
    );
    const td = thongDiepKetLuan(
      ketLuanTienDo(soLieu({ sau: 30_000, soLuot: 20, buocCuoi: { status: "ERROR", error: loi } })),
    );
    expect(td?.muc).toBe("loi");
    expect(td?.noiDung).toContain("purchases/kho");
  });

  it("body rỗng / `{}` ⇒ không lỗi kéo; soLoiKeo > số dòng ⇒ câu nói phần còn lại", () => {
    expect(docTomTatLoiKeo("")).toEqual({ soLoiKeo: 0, loiKeo: [], canhBao: null });
    expect(docTomTatLoiKeo("{}")).toEqual({ soLoiKeo: 0, loiKeo: [], canhBao: null });
    expect(cauLoiKeo(docTomTatLoiKeo("{}"))).toBeNull();
    const t = docTomTatLoiKeo(
      JSON.stringify({ soLoiKeo: 25, loiKeo: [{ scope: "MOT_TRANG", stream: "orders", shop: "shopee" }] }),
    );
    expect(t.soLoiKeo).toBe(25);
    expect(cauLoiKeo(t)).toContain("orders/shopee (MOT_TRANG)");
    expect(cauLoiKeo(t)).toContain("24 lượt khác");
  });

  it("soLoiKeo thiếu/nhỏ hơn số dòng ⇒ lấy số dòng (tổng không nói ít hơn chi tiết)", () => {
    const t = docTomTatLoiKeo(JSON.stringify({ loiKeo: [{ scope: "X", stream: "purchases", shop: "kho" }] }));
    expect(t.soLoiKeo).toBe(1);
  });
});
