import { beforeEach, describe, expect, it } from "vitest";

import {
  chanRouteKhiDangPhucHoi,
  dangDungLaiTuKhoTho,
  dangPhucHoi,
  thuGiuKhoaDungLai,
  thuGiuKhoaPhucHoi,
  traKhoaDungLai,
  traKhoaPhucHoi,
} from "@/lib/backup/khoa-bao-tri";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";

/**
 * Khoá bảo trì (trong tiến trình) — chặn 2 lượt phục hồi chồng nhau và chặn đường ghi trong lúc
 * schema đích bị xoá + nạp lại. Test THUẦN, không đụng DB.
 */
describe("khoá phục hồi", () => {
  beforeEach(() => {
    donKhoaPhucHoi();
    traKhoaDungLai();
  });

  it("lượt thứ hai KHÔNG giành được khoá khi lượt đầu chưa trả", () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    expect(thuGiuKhoaPhucHoi()).toBeNull();
    expect(dangPhucHoi()).toBe(true);
  });

  it("trả khoá xong thì lượt sau giành được — lỗi giữa chừng không khoá app vĩnh viễn", () => {
    const the = thuGiuKhoaPhucHoi()!;
    traKhoaPhucHoi(the);
    expect(dangPhucHoi()).toBe(false);
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
  });

  it("đang phục hồi → route ghi bị chặn bằng 503 kèm Retry-After (tạm bận, không phải hỏng hợp đồng)", async () => {
    expect(chanRouteKhiDangPhucHoi()).toBeNull();

    thuGiuKhoaPhucHoi();
    const res = chanRouteKhiDangPhucHoi();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    expect(res!.headers.get("Retry-After")).toBe("60");
    expect((await res!.json()).ok).toBe(false);
  });
});

describe("khoá dựng lại từ kho thô", () => {
  beforeEach(() => {
    donKhoaPhucHoi(); // cả hai cờ dùng chung module — dọn sạch để test không phụ thuộc thứ tự chạy
    traKhoaDungLai();
  });

  it("loại trừ lượt thứ hai, và ĐỘC LẬP với khoá phục hồi (hai mối lo khác nhau)", () => {
    expect(thuGiuKhoaDungLai()).toBe(true);
    expect(thuGiuKhoaDungLai()).toBe(false);
    expect(dangDungLaiTuKhoTho()).toBe(true);
    // Dựng lại KHÔNG được kéo theo trạng thái "đang phục hồi" — nếu lẫn, mọi ingest sẽ bị 503 oan
    // suốt lượt dựng lại.
    expect(dangPhucHoi()).toBe(false);

    traKhoaDungLai();
    expect(dangDungLaiTuKhoTho()).toBe(false);
  });
});
