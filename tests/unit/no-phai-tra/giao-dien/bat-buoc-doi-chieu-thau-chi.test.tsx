// @vitest-environment jsdom
/**
 * Bước 2 màn bật nợ phải trả khi đang có thấu chi: thấu chi giải ngân VÀO tài khoản (quỹ app gồm `LOAN_IN`,
 * số dư tài khoản gồm tiền vay) ⇒ chênh lệch so thẳng tiền thật với quỹ; dư nợ chỉ hiện một dòng THAM KHẢO,
 * và lời dặn ô ngân hàng không còn bảo "gõ số âm" vì thấu chi.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BuocDoiChieu } from "@/components/no-phai-tra/bat-buoc-doi-chieu";
import { tinhChenhLechTaiM } from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

afterEach(cleanup);

const ketQua = {
  ...tinhChenhLechTaiM({
    quyApp: 357_445_000,
    soDuBank: 62_400_000,
    tienMat: 0,
    duNoThauChi: 137_000_000,
    the: [{ khoa: "the:9999", nhan: "nợ thẻ 9999", soTien: 33_650_000 }],
    phieuY: [],
    viAds: [],
  }),
  ngayTruocM: "2026-10-14",
  tienDangGui: 0,
  vanTay: { quyApp: 357_445_000, duNoThauChi: 137_000_000, tongPhieuY: 0 },
};

function veBuoc2(kq: typeof ketQua = ketQua) {
  return render(
    <BuocDoiChieu
      bankRaw="62.400.000"
      onBankRaw={() => {}}
      tienMat={0}
      onTienMat={() => {}}
      coTheTinh
      dangTinh={false}
      onTinh={() => {}}
      ketQua={kq}
      luaChon="toan-bo"
      onLuaChon={() => {}}
      dieuChinh={[]}
      onDieuChinh={() => {}}
      nhanTruocM="14/10/2026"
    />
  );
}

describe("bước 2 đối chiếu — thấu chi giải ngân vào tài khoản", () => {
  it("chênh lệch không cộng dư nợ; dư nợ thấu chi là dòng tham khảo riêng", () => {
    veBuoc2();
    const bang = screen.getByTestId("bat-bang-chenh-lech");
    const chu = bang.textContent ?? "";
    // `formatVnd` in dấu trừ dài (U+2212).
    expect(chu).toMatch(/Chênh lệch \(dương = tiền thật nhiều hơn sổ\)−295\.045\.000/);
    expect(screen.getByTestId("bat-dong-chua-giai-thich").textContent).toMatch(/−328\.695\.000/);
    expect(screen.getByTestId("bat-du-no-thau-chi-tham-khao").textContent).toMatch(
      /^Dư nợ thấu chi \(theo dõi riêng, không cộng vào đối chiếu\)137\.000\.000/
    );
    expect(chu).not.toContain("Cộng dư nợ thấu chi");
  });

  it("lời dặn ô ngân hàng: số dư thật trên tài khoản thanh toán, không bảo gõ âm vì thấu chi", () => {
    const { container } = veBuoc2();
    const chu = container.textContent ?? "";
    expect(chu).toContain("Gõ đúng số dư thật trên tài khoản THANH TOÁN");
    expect(chu).not.toContain("đang thấu chi thì gõ số âm");
  });

  it("số 15/10 (đã gột) (chưa giải thích −328.695.000) ⇒ KHÔNG hiện cảnh báo trừ nhầm thấu chi", () => {
    veBuoc2();
    expect(screen.queryByTestId("bat-canh-bao-tru-nham-thau-chi")).toBeNull();
  });

  it("chưa giải thích đúng −dư nợ thấu chi ⇒ hiện cảnh báo nhắc nhập số dư THẬT", () => {
    const kq = {
      ...tinhChenhLechTaiM({
        quyApp: 62_400_000,
        soDuBank: -74_600_000,
        tienMat: 0,
        duNoThauChi: 137_000_000,
        the: [],
        phieuY: [],
        viAds: [],
      }),
      ngayTruocM: "2026-10-14",
      tienDangGui: 0,
      vanTay: { quyApp: 62_400_000, duNoThauChi: 137_000_000, tongPhieuY: 0 },
    };
    veBuoc2(kq);
    expect(screen.getByTestId("bat-canh-bao-tru-nham-thau-chi").textContent).toBe(
      "Chênh đúng bằng dư nợ thấu chi — có thể bạn đã trừ khoản thấu chi khỏi số dư ngân hàng. " +
        "Ô ngân hàng nhập số dư THẬT trên tài khoản (thấu chi theo dõi riêng)."
    );
  });
});
