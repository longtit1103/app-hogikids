import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatVnd } from "@/lib/format";
import {
  doiChieuPhieuNhap,
  refIdChoPhieu,
  rutPhieuTuPayload,
  type PhieuNhapPancake,
} from "@/lib/nhap-hang/doi-chieu-phieu-nhap";

/**
 * Lõi đọc đề xuất chi phí nhập hàng từ Pancake.
 *
 * Fixture là payload THẬT rút từ Bronze prod 17/09 (bỏ blob `items[].variation`, ẩn danh tên người
 * — GIỮ NGUYÊN mọi field tiền/ngày/trạng thái). Fixture viết tay ở đây là phantom guard: chính
 * `transport_fee` và `status` đổi giá trị mới là thứ đã làm sai tiền trên prod.
 */
const PHIEU_THAT = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake/phieu-nhap-sample.json"), "utf8"),
) as unknown[];

/** Ngày mở sổ quỹ thật trên prod lúc đo. */
const D0 = new Date(2026, 4, 12);

const UUID = {
  huy173: "ff141732-01c0-46b7-981c-0c31b7f7aa3d",
  huy179: "e23d4809-a3fa-44a1-8b1e-5c82da38bdd5",
  p181: "a15aa15c-8bee-448a-b98b-e3991de86b21",
  p182: "2a7a4f7d-fc95-4ec9-9608-555e3524681f",
  p183: "731c1f99-6f66-444a-8ce9-7bb8d99284c8",
  p184: "be24b011-bdfa-49d6-b50a-0919dd26d056",
};

function rutTatCa(): PhieuNhapPancake[] {
  return PHIEU_THAT.map(rutPhieuTuPayload).filter((p): p is PhieuNhapPancake => p !== null);
}

describe("rutPhieuTuPayload", () => {
  it("fixture là 9 phiếu nhập hàng thật, rút được hết", () => {
    expect(PHIEU_THAT).toHaveLength(9);
    expect(rutTatCa()).toHaveLength(9);
  });

  it("bỏ phiếu điều chỉnh kho và payload hỏng", () => {
    expect(rutPhieuTuPayload({ ...(PHIEU_THAT[0] as object), created_type: "adjust_warehouse" })).toBeNull();
    expect(rutPhieuTuPayload(null)).toBeNull();
    expect(rutPhieuTuPayload({ created_type: "actual_purchase" })).toBeNull();
  });

  it("tiền lấy THẲNG total_price, KHÔNG cộng transport_fee", () => {
    const p183 = rutTatCa().find((p) => p.uuid === UUID.p183)!;

    // Phiếu #183 có transport_fee = 300.000: cộng vào là 53.899.970 ⇒ test này đỏ.
    expect(p183.soTien).toBe(53_599_970);
  });

  it("lưới kiểm: total_price = Σ quantity × imported_price ở cả 9 phiếu", () => {
    for (const p of rutTatCa()) {
      expect({ uuid: p.uuid, tong: p.tongTuDongHang }).toEqual({ uuid: p.uuid, tong: p.soTien });
    }
  });

  it("inserted_at naive là giờ UTC ⇒ đầu ngày VN đúng, không lùi hôm trước", () => {
    const p183 = rutTatCa().find((p) => p.uuid === UUID.p183)!;

    // Payload ghi "2026-09-12T02:45:00" = 09:45 giờ VN ⇒ ngày 12/09, KHÔNG phải 11/09.
    expect(p183.ngay.getFullYear()).toBe(2026);
    expect(p183.ngay.getMonth()).toBe(8);
    expect(p183.ngay.getDate()).toBe(12);
    expect(p183.ngay.getHours()).toBe(0);
  });

  it("supplier vắng khoá ⇒ null; có thì lấy tên", () => {
    const theoUuid = new Map(rutTatCa().map((p) => [p.uuid, p]));

    expect(theoUuid.get(UUID.p181)!.nhaCungCap).toBeNull();
    expect(theoUuid.get(UUID.p183)!.nhaCungCap).not.toBeNull();
  });

  it("note chủ shop gõ được giữ để hiện trên màn duyệt", () => {
    const p181 = rutTatCa().find((p) => p.uuid === UUID.p181)!;

    expect(p181.ghiChu).toContain("11.000k");
    expect(rutTatCa().find((p) => p.uuid === UUID.p183)!.ghiChu).toBeNull();
  });

  it("status giữ nguyên số Pancake (1 còn hiệu lực, 2 đã huỷ)", () => {
    const theoUuid = new Map(rutTatCa().map((p) => [p.uuid, p]));

    expect(theoUuid.get(UUID.huy173)!.status).toBe(2);
    expect(theoUuid.get(UUID.huy179)!.status).toBe(2);
    expect(theoUuid.get(UUID.p184)!.status).toBe(1);
  });
});

describe("doiChieuPhieuNhap — luật lọc chốt với chủ shop", () => {
  it("9 phiếu thật + D0 12/05/2026 ⇒ đúng 4 đề xuất, Σ 223.099.858đ", () => {
    const kq = doiChieuPhieuNhap({ phieu: rutTatCa(), expense: [], d0: D0 });

    expect(kq.deXuat.map((d) => d.displayId)).toEqual([181, 182, 183, 184]);
    expect(kq.deXuat.reduce((s, d) => s + d.soTien, 0)).toBe(223_099_858);
    expect(kq.canhBao).toEqual([]);
  });

  it("phiếu status=2 bị loại kể cả khi sau D0", () => {
    const phieu = rutTatCa().map((p) =>
      p.uuid === UUID.p184 ? { ...p, status: 2 } : p,
    );

    const kq = doiChieuPhieuNhap({ phieu, expense: [], d0: D0 });

    expect(kq.deXuat.map((d) => d.displayId)).toEqual([181, 182, 183]);
    // Phiếu huỷ CHƯA ghi sổ thì không có tiền sai ở đâu ⇒ im lặng, không đếm vào "bỏ qua trước D0".
    expect(kq.canhBao).toEqual([]);
    expect(kq.boQuaTruocD0.soPhieu).toBe(3);
  });

  it("phiếu trước D0 bị loại nhưng vẫn đếm riêng kèm tổng tiền", () => {
    const kq = doiChieuPhieuNhap({ phieu: rutTatCa(), expense: [], d0: D0 });

    // 3 phiếu status=1 tháng 03/2026 (#175 #176 #177); 2 phiếu huỷ #173/#179 không tính vào đây.
    expect(kq.boQuaTruocD0).toEqual({ soPhieu: 3, tongTien: 1_250_000 + 54_000_000 + 69_619_852 });
  });

  it("chưa mở sổ quỹ (d0 null) ⇒ không chặn theo ngày", () => {
    const kq = doiChieuPhieuNhap({ phieu: rutTatCa(), expense: [], d0: null });

    expect(kq.deXuat).toHaveLength(7);
    expect(kq.boQuaTruocD0).toEqual({ soPhieu: 0, tongTien: 0 });
  });

  it("refId là PANCAKE_PURCHASE:{uuid} và phiếu đã ghi rơi sang daGhi", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [{ id: "e1", refId: refIdChoPhieu(UUID.p182), amount: 59_559_808 }],
      d0: D0,
    });

    expect(kq.deXuat.map((d) => d.refId)).toEqual([
      `PANCAKE_PURCHASE:${UUID.p181}`,
      `PANCAKE_PURCHASE:${UUID.p183}`,
      `PANCAKE_PURCHASE:${UUID.p184}`,
    ]);
    expect(kq.daGhi).toHaveLength(1);
    expect(kq.daGhi[0]).toMatchObject({ expenseId: "e1", lechTien: false, daHuyBenPancake: false });
    expect(kq.canhBao).toEqual([]);
  });

  it("đề xuất mang đủ số lượng, số dòng hàng để màn duyệt hiện", () => {
    const kq = doiChieuPhieuNhap({ phieu: rutTatCa(), expense: [], d0: D0 });
    const p184 = kq.deXuat.find((d) => d.displayId === 184)!;

    expect(p184).toMatchObject({ soTien: 80_940_160, soLuong: 448, soDongHang: 14 });
  });
});

describe("doiChieuPhieuNhap — hậu kiểm phiếu đã ghi sổ", () => {
  it("phiếu đã ghi Expense nay bị huỷ bên Pancake ⇒ cảnh báo nêu số tiền phải xoá", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [{ id: "e-huy", refId: refIdChoPhieu(UUID.huy179), amount: 15_000_000 }],
      d0: D0,
    });

    expect(kq.daGhi).toHaveLength(1);
    expect(kq.daGhi[0]).toMatchObject({ daHuyBenPancake: true, lechTien: false });
    expect(kq.canhBao).toHaveLength(1);
    expect(kq.canhBao[0]).toContain("#179");
    expect(kq.canhBao[0]).toContain("đã bị huỷ bên Pancake");
    expect(kq.canhBao[0]).toContain("15.000.000");
  });

  it("phiếu đã ghi nay đổi số tiền ⇒ cảnh báo nêu CẢ HAI số", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [{ id: "e-lech", refId: refIdChoPhieu(UUID.p184), amount: 80_000_000 }],
      d0: D0,
    });

    expect(kq.daGhi[0]).toMatchObject({ lechTien: true, soTienDaGhi: 80_000_000, soTien: 80_940_160 });
    expect(kq.canhBao).toHaveLength(1);
    expect(kq.canhBao[0]).toContain("80.000.000");
    expect(kq.canhBao[0]).toContain("80.940.160");
  });

  it("phiếu trước D0 đã ghi sổ vẫn được hậu kiểm (không bị lọc mất)", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [{ id: "e-cu", refId: refIdChoPhieu(UUID.huy173), amount: 22_699_950 }],
      d0: D0,
    });

    expect(kq.daGhi.map((d) => d.displayId)).toEqual([173]);
    expect(kq.canhBao[0]).toContain("đã bị huỷ bên Pancake");
  });
});

describe("doiChieuPhieuNhap — lưới kiểm tiền", () => {
  it("total_price lệch Σ dòng hàng ⇒ cảnh báo nhưng VẪN dùng total_price", () => {
    const phieu = rutTatCa().map((p) =>
      p.uuid === UUID.p183 ? { ...p, tongTuDongHang: p.soTien - 300_000 } : p,
    );

    const kq = doiChieuPhieuNhap({ phieu, expense: [], d0: D0 });
    const p183 = kq.deXuat.find((d) => d.displayId === 183)!;

    expect(p183.soTien).toBe(53_599_970);
    expect(p183.lechLuoiKiem).toBe(true);
    expect(kq.canhBao).toHaveLength(1);
    expect(kq.canhBao[0]).toContain("#183");
    expect(kq.canhBao[0]).toContain("53.599.970");
    expect(kq.canhBao[0]).toContain("53.299.970");
  });
});

/**
 * Pancake thêm mã trạng thái mới là ca ĐÃ ĐO ĐƯỢC LÀ SẼ TỚI (bảng mã trôi, app không kiểm soát).
 * Hai luật đối nghịch phải cùng đúng: KHÔNG tự ghi tiền theo mã lạ, và KHÔNG được im lặng.
 */
describe("doiChieuPhieuNhap — status lạ (không phải 1, không phải 2)", () => {
  /** Ép phiếu #184 (80.940.160đ, sau D0) mang mã 3 — mô phỏng Pancake thêm trạng thái mới. */
  function phieuVoiMaLa(status = 3): PhieuNhapPancake[] {
    return rutTatCa().map((p) => (p.uuid === UUID.p184 ? { ...p, status } : p));
  }

  it("chưa ghi sổ ⇒ KHÔNG đề xuất nhưng PHẢI cảnh báo kèm mã và tổng tiền", () => {
    const kq = doiChieuPhieuNhap({ phieu: phieuVoiMaLa(), expense: [], d0: D0 });

    expect(kq.deXuat.map((d) => d.displayId)).toEqual([181, 182, 183]);
    expect(kq.canhBao).toHaveLength(1);
    expect(kq.canhBao[0]).toContain("trạng thái app chưa biết (mã 3)");
    expect(kq.canhBao[0]).toContain("80.940.160");
    // Số này là thứ đẩy lên dải nhắc việc — không có nó thì cảnh báo chỉ ai TỰ NHỚ mở màn mới thấy.
    expect(kq.soViecHauKiem).toBe(1);
  });

  it("nhiều phiếu cùng mã lạ ⇒ gộp MỘT câu, đếm đủ việc", () => {
    const phieu = rutTatCa().map((p) =>
      p.uuid === UUID.p184 || p.uuid === UUID.p183 ? { ...p, status: 3 } : p,
    );

    const kq = doiChieuPhieuNhap({ phieu, expense: [], d0: D0 });

    expect(kq.canhBao).toHaveLength(1);
    expect(kq.canhBao[0]).toContain("Có 2 phiếu nhập mang trạng thái app chưa biết (mã 3)");
    expect(kq.canhBao[0]).toContain(formatVnd(80_940_160 + 53_599_970));
    expect(kq.soViecHauKiem).toBe(2);
  });

  it("mã lạ TRƯỚC ngày mở sổ ⇒ im lặng (tiền đã nằm trong số dư mở sổ)", () => {
    // #176 ngày 27/03/2026, trước D0 12/05/2026.
    const phieu = rutTatCa().map((p) => (p.displayId === 176 ? { ...p, status: 7 } : p));

    const kq = doiChieuPhieuNhap({ phieu, expense: [], d0: D0 });

    expect(kq.canhBao).toEqual([]);
    expect(kq.soViecHauKiem).toBe(0);
    // Không được lẫn vào "bỏ qua trước D0" — đó là số của phiếu HỢP LỆ, dùng để nói tổng tiền.
    expect(kq.boQuaTruocD0).toEqual({ soPhieu: 2, tongTien: 1_250_000 + 69_619_852 });
  });

  it("ĐÃ ghi sổ + mã lạ ⇒ KHÔNG bao giờ khuyên xoá dòng chi", () => {
    const kq = doiChieuPhieuNhap({
      phieu: phieuVoiMaLa(),
      expense: [{ id: "e-la", refId: refIdChoPhieu(UUID.p184), amount: 80_940_160 }],
      d0: D0,
    });

    expect(kq.daGhi[0]).toMatchObject({ daHuyBenPancake: false, trangThaiLa: true, status: 3 });
    expect(kq.canhBao).toHaveLength(1);
    expect(kq.canhBao[0]).toContain("mã 3");
    // Câu "nên xoá dòng đó" ở đây là mất trắng 80.940.160đ khỏi quỹ vì một mã app không hiểu.
    expect(kq.canhBao[0]).not.toContain("nên xoá");
    expect(kq.canhBao[0]).toContain("giữ nguyên dòng chi");
    expect(kq.soViecHauKiem).toBe(1);
  });
});

describe("doiChieuPhieuNhap — soViecHauKiem", () => {
  it("mọi thứ khớp ⇒ 0 việc", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [{ id: "e1", refId: refIdChoPhieu(UUID.p182), amount: 59_559_808 }],
      d0: D0,
    });

    expect(kq.soViecHauKiem).toBe(0);
  });

  it("đếm phiếu đã ghi bị huỷ và phiếu đã ghi lệch tiền, mỗi phiếu tính MỘT việc", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [
        { id: "e-huy", refId: refIdChoPhieu(UUID.huy179), amount: 15_000_000 },
        { id: "e-lech", refId: refIdChoPhieu(UUID.p184), amount: 80_000_000 },
      ],
      d0: D0,
    });

    expect(kq.soViecHauKiem).toBe(2);
  });

  it("một phiếu vừa huỷ vừa lệch tiền vẫn là MỘT việc", () => {
    const kq = doiChieuPhieuNhap({
      phieu: rutTatCa(),
      expense: [{ id: "e-huy", refId: refIdChoPhieu(UUID.huy179), amount: 9_000_000 }],
      d0: D0,
    });

    expect(kq.daGhi[0]).toMatchObject({ daHuyBenPancake: true, lechTien: true });
    expect(kq.soViecHauKiem).toBe(1);
  });
});
