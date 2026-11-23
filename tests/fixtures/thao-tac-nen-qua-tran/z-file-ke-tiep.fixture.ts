import { it } from "vitest";

import { ghiDau } from "./dau-thu-muc";

/** File thứ hai của lượt con: chạy được tức là lượt KHÔNG bị huỷ sau khi file trước gặp thao tác còn sống quá trần. */
it("file kế tiếp", () => {
  ghiDau("file-ke-chay");
});
