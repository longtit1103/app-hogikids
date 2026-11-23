import { afterAll, afterEach, beforeEach, it, vi } from "vitest";

import {
  chayNen,
  doiCauHinhChoTestHopDong,
  dangKyTheHeCa,
  donSauKhiThaoTacNenXong,
  moTheoDoiThaoTacNen,
  TIMEOUT_HOOK_DON_MS,
} from "../../helpers/thao-tac-nen-cho-xong-truoc-khi-don";

import { ghiDau } from "./dau-thu-muc";

/**
 * Như file a, nhưng `writeSync` (helper dùng để in khung lý do ra stderr) LUÔN ném EAGAIN — đúng lỗi của pipe stderr
 * non-blocking đầy ở pool forks. Ghi lỗi vẫn phải huỷ cả lượt: không `afterAll`, không ca kế, không file kế.
 * Dấu `ghi-stderr-nem` chứng minh helper đã thật sự đi qua lối ghi lỗi.
 */
vi.mock("node:fs", async (layGoc) => {
  const goc = await layGoc<typeof import("node:fs")>();
  return {
    ...goc,
    writeSync: () => {
      goc.writeFileSync(`${process.env.THU_MUC_DAU_QUA_TRAN}/ghi-stderr-nem`, "");
      throw Object.assign(new Error("EAGAIN giả lập: pipe stderr đầy"), { code: "EAGAIN" });
    },
  };
});

doiCauHinhChoTestHopDong({ tranChoXongMs: 300 });

dangKyTheHeCa();

beforeEach(() => {
  moTheoDoiThaoTacNen();
});

afterEach(() => donSauKhiThaoTacNenXong(() => ghiDau("don-chay")), TIMEOUT_HOOK_DON_MS);

afterAll(() => {
  ghiDau("after-all-chay");
});

it("ca 1: thao tác nền còn sống quá trần, stderr ghi lỗi", () => {
  ghiDau("ca-1-bat-dau");
  void chayNen("thao tác nền chậm", async () => {
    await new Promise((r) => setTimeout(r, 1_000));
    ghiDau("thao-tac-nen-xong");
  });
});

it("ca 2: ca kế trong cùng file", () => {
  ghiDau("ca-2-chay");
});
