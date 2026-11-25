import { afterAll, afterEach, beforeEach, expect, it } from "vitest";

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
 * Như `a-thao-tac-con-song-qua-tran` nhưng ca ĐỎ TRƯỚC (assertion hỏng) trong lúc thao tác đã đăng ký còn sống quá trần:
 * lượt bị huỷ thì reporter không kịp in lỗi của ca, nên khung lý do huỷ lượt phải tự mang lỗi gốc đó. Hành động huỷ lượt
 * giữ MẶC ĐỊNH (thật).
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

it("ca 1: ca đỏ vì assertion rồi thao tác nền còn sống quá trần", () => {
  ghiDau("ca-1-bat-dau");
  void chayNen("thao tác nền chậm", async () => {
    await new Promise((r) => setTimeout(r, 1_000));
    ghiDau("thao-tac-nen-xong");
  });
  expect("lỗi gốc của ca: số thực tế").toBe("lỗi gốc của ca: số kỳ vọng");
});
