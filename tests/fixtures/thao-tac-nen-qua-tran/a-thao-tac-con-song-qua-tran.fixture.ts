import { afterAll, afterEach, beforeEach, it } from "vitest";

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
 * File thứ nhất của lượt con: ca 1 khởi chạy một thao tác đã đăng ký sống 1s rồi kết thúc thân test ngay (như thân test
 * đã chết), trần chờ rút còn 300ms. Hành động huỷ lượt giữ MẶC ĐỊNH (thật). Mỗi dấu là bằng chứng một việc lẽ ra KHÔNG
 * được chạy: lượt dọn, ca kế, `afterAll`, phần cuối của thao tác còn sống.
 */
doiCauHinhChoTestHopDong({ tranChoXongMs: 300 });

dangKyTheHeCa();

beforeEach(() => {
  moTheoDoiThaoTacNen();
});

afterEach(() => donSauKhiThaoTacNenXong(() => ghiDau("don-chay")), TIMEOUT_HOOK_DON_MS);

afterAll(() => {
  ghiDau("after-all-chay");
});

it("ca 1: thao tác nền còn sống quá trần", () => {
  ghiDau("ca-1-bat-dau");
  void chayNen("thao tác nền chậm", async () => {
    await new Promise((r) => setTimeout(r, 1_000));
    ghiDau("thao-tac-nen-xong");
  });
});

it("ca 2: ca kế trong cùng file", () => {
  ghiDau("ca-2-chay");
});
