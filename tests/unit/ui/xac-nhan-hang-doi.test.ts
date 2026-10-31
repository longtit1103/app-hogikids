import { describe, expect, it } from "vitest";

import { dangKyHost, traLoiXacNhan, xacNhan, yeuCauHienTai } from "@/lib/xac-nhan-hang-doi";

describe("hàng đợi xác nhận (thuần, không DOM)", () => {
  it("không có host ⇒ false ngay", async () => {
    expect(yeuCauHienTai()).toBeNull();
    await expect(xacNhan("x")).resolves.toBe(false);
    expect(yeuCauHienTai()).toBeNull();
  });

  it("host gắn ⇒ yêu cầu xếp hàng, trả lời lần lượt", async () => {
    const goHost = dangKyHost();
    const a = xacNhan({ noiDung: "a" });
    const b = xacNhan("b");
    expect(yeuCauHienTai()?.noiDung).toBe("a");
    traLoiXacNhan(true);
    await expect(a).resolves.toBe(true);
    expect(yeuCauHienTai()?.noiDung).toBe("b");
    traLoiXacNhan(false);
    await expect(b).resolves.toBe(false);
    expect(yeuCauHienTai()).toBeNull();
    goHost();
  });

  it("trả lời muộn cho yêu cầu cũ (sự kiện đóng hộp đến sau nút Đồng ý) không đụng yêu cầu kế", async () => {
    const goHost = dangKyHost();
    const a = xacNhan("a");
    const b = xacNhan("b");
    const dangHienThi = yeuCauHienTai();
    traLoiXacNhan(true, dangHienThi);
    await expect(a).resolves.toBe(true);
    traLoiXacNhan(false, dangHienThi); // sự kiện đóng muộn của yêu cầu "a"
    expect(yeuCauHienTai()?.noiDung).toBe("b");
    traLoiXacNhan(true);
    await expect(b).resolves.toBe(true);
    goHost();
  });

  it("gỡ host cuối ⇒ từ chối mọi yêu cầu còn treo", async () => {
    const goHost = dangKyHost();
    const a = xacNhan("a");
    goHost();
    await expect(a).resolves.toBe(false);
    expect(yeuCauHienTai()).toBeNull();
  });
});
