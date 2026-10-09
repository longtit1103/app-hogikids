import { describe, expect, it } from "vitest";

import { NEN_TANG_CHON } from "@/components/no-phai-tra/nen-tang-gan-the";
import { NEN_TANG_GAN_THE } from "@/lib/no-phai-tra/the-tin-dung-queries";

/** Danh sách nền tảng ở form (client) phải BẰNG danh sách server chấp nhận — lệch là form mời chọn thứ bị từ chối. */
describe("nền tảng gắn thẻ: form ↔ server", () => {
  it("cùng tập giá trị, theo cùng thứ tự", () => {
    expect(NEN_TANG_CHON.map((n) => n.value)).toEqual([...NEN_TANG_GAN_THE]);
  });
  it("không có SHOPEE_ADS", () => {
    expect(NEN_TANG_CHON.map((n) => n.value)).not.toContain("SHOPEE_ADS");
  });
});
