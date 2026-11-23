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
 * Như file a, nhưng `writeSync` mô phỏng pipe stderr non-blocking của worker forks: 3 lần đầu ném EAGAIN (pipe đầy),
 * sau đó mỗi lần chỉ ghi THẬT tối đa 64 byte (ghi một phần). Khung lý do phải tới tiến trình chính ĐỦ, rồi lượt vẫn bị
 * huỷ. Dấu `eagain-da-nem` chứng minh lối EAGAIN đã thật sự được đi qua.
 */
vi.mock("node:fs", async (layGoc) => {
  const goc = await layGoc<typeof import("node:fs")>();
  let soLanEagain = 0;
  return {
    ...goc,
    writeSync: (fd: number, buf: Buffer, offset: number) => {
      if (soLanEagain < 3) {
        soLanEagain++;
        if (soLanEagain === 3) goc.writeFileSync(`${process.env.THU_MUC_DAU_QUA_TRAN}/eagain-da-nem`, "");
        throw Object.assign(new Error("EAGAIN giả lập: pipe stderr đầy"), { code: "EAGAIN" });
      }
      return goc.writeSync(fd, buf, offset, Math.min(64, buf.length - offset));
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

it("ca 1: thao tác nền còn sống quá trần, stderr đầy rồi ghi từng phần", () => {
  ghiDau("ca-1-bat-dau");
  void chayNen("thao tác nền chậm", async () => {
    await new Promise((r) => setTimeout(r, 1_000));
    ghiDau("thao-tac-nen-xong");
  });
});

it("ca 2: ca kế trong cùng file", () => {
  ghiDau("ca-2-chay");
});
