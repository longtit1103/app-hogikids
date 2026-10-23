import { afterEach, describe, expect, it } from "vitest";

import {
  docIpCloudflare,
  ghiLuotSaiTheoIp,
  giayConKhoaTheoIp,
  SO_LAN_SAI_TOI_DA_THEO_IP,
  THOI_GIAN_KHOA_IP_MS,
  TRAN_SO_IP_THEO_DOI,
  xoaBoDemTheoIp,
} from "@/lib/auth/khoa-dang-nhap-theo-ip";

/** Header giả chỉ trả `cf-connecting-ip`. */
const header = (giaTri: string | null) => ({
  get: (ten: string) => (ten === "cf-connecting-ip" ? giaTri : null),
});

const IP = "203.0.113.9";

describe("docIpCloudflare", () => {
  it("thiếu/rỗng/không giống IP ⇒ null (không đếm theo IP)", () => {
    expect(docIpCloudflare(header(null))).toBeNull();
    expect(docIpCloudflare(header(""))).toBeNull();
    expect(docIpCloudflare(header("   "))).toBeNull();
    expect(docIpCloudflare(header("1.2.3.4, 5.6.7.8"))).toBeNull();
    expect(docIpCloudflare(header("<script>"))).toBeNull();
    expect(docIpCloudflare(header("a".repeat(46)))).toBeNull();
  });

  it("IPv4/IPv6 hợp lệ ⇒ trả về đã trim + chữ thường", () => {
    expect(docIpCloudflare(header(` ${IP} `))).toBe(IP);
    expect(docIpCloudflare(header("2001:DB8::1"))).toBe("2001:db8::1");
  });
});

describe("bộ đếm khoá theo IP", () => {
  afterEach(() => xoaBoDemTheoIp(IP));

  it("ngưỡng 20 lượt sai ⇒ khoá 5 phút rồi tự mở", () => {
    expect(SO_LAN_SAI_TOI_DA_THEO_IP).toBe(20);
    expect(THOI_GIAN_KHOA_IP_MS).toBe(300_000);
    const moc = 1_000;
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP - 1; i += 1) ghiLuotSaiTheoIp(IP, moc);
    expect(giayConKhoaTheoIp(IP, moc)).toBe(0);

    ghiLuotSaiTheoIp(IP, moc);
    expect(giayConKhoaTheoIp(IP, moc)).toBe(300);
    expect(giayConKhoaTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS - 1_000)).toBe(1);
    expect(giayConKhoaTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS)).toBe(0);
  });

  it("im lặng đủ 5 phút ⇒ bộ đếm về 0 (cửa sổ trượt, không cộng dồn lượt gõ nhầm cả ngày)", () => {
    const moc = 1_000;
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP - 1; i += 1) ghiLuotSaiTheoIp(IP, moc);
    ghiLuotSaiTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS);
    expect(giayConKhoaTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS)).toBe(0);

    // Cửa sổ mới đã có 1 lượt: thêm 19 lượt liền nữa mới khoá.
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP - 2; i += 1) ghiLuotSaiTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS + 1);
    expect(giayConKhoaTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS + 1)).toBe(0);
    ghiLuotSaiTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS + 1);
    expect(giayConKhoaTheoIp(IP, moc + THOI_GIAN_KHOA_IP_MS + 1)).toBeGreaterThan(0);
  });

  it("bơm IP giả cho tràn trần KHÔNG đẩy được lệnh khoá đang hiệu lực; Map được dọn", () => {
    const moc = 50_000_000;
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP; i += 1) ghiLuotSaiTheoIp(IP, moc);
    expect(giayConKhoaTheoIp(IP, moc)).toBeGreaterThan(0);

    const soIpGia = TRAN_SO_IP_THEO_DOI + 30;
    const ipGia = (i: number) => `10.0.${i >> 8}.${i & 255}`;
    for (let i = 0; i < soIpGia; i += 1) ghiLuotSaiTheoIp(ipGia(i), moc + 1 + i);

    expect(giayConKhoaTheoIp(IP, moc + soIpGia + 60)).toBeGreaterThan(0);

    // IP giả ghi ĐẦU TIÊN (chưa khoá, cũ nhất) đã bị loại để nhường chỗ: ghi lại 19 lượt chỉ đưa bộ
    // đếm lên 19 (< 20) — còn giữ thì 1 + 19 = 20 sẽ khoá.
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP - 1; i += 1) ghiLuotSaiTheoIp(ipGia(0), moc + soIpGia + 61);
    expect(giayConKhoaTheoIp(ipGia(0), moc + soIpGia + 61)).toBe(0);

    for (let i = 0; i < soIpGia; i += 1) xoaBoDemTheoIp(ipGia(i));
  });
});
