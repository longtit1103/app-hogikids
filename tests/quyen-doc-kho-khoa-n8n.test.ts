import { describe, expect, it } from "vitest";

import {
  cauCapLaiQuyen,
  docQuyenDocN8n,
  phanLoaiQuyenN8n,
  type QuyenN8nThô,
} from "@/lib/n8n/quyen-doc-kho-khoa";
import { N8N_RO_ROLE } from "@/lib/n8n/role-doc-kho-khoa";

/**
 * Lưới cho ô cảnh báo "n8n mất quyền đọc kho khoá".
 *
 * Trọng tâm KHÔNG phải "hàm chạy không lỗi" mà là hai cửa ngược nhau, cả hai đều hỏng âm thầm nếu
 * sai: cảnh báo phải NỔI khi quyền thiếu thật, và phải IM ở database test (nơi role tồn tại ở mức
 * cụm nhưng chưa bao giờ được cấp quyền — báo ở đó là dạy người ta phớt lờ màu đỏ).
 */

const DU: QuyenN8nThô = {
  database: "postgres",
  schema: "app",
  coRole: true,
  coUsage: true,
  coSelect: true,
  coSelectBangGoc: false,
};

describe("phân loại quyền đọc kho khoá của n8n", () => {
  it("đủ quyền ⇒ không cảnh báo", () => {
    expect(phanLoaiQuyenN8n(DU)).toEqual({ trangThai: "DU_QUYEN" });
  });

  it("thiếu SELECT trên view kho khoá ⇒ cảnh báo, nêu đúng quyền thiếu", () => {
    const kq = phanLoaiQuyenN8n({ ...DU, coSelect: false });
    expect(kq.trangThai).toBe("THIEU_QUYEN");
    if (kq.trangThai !== "THIEU_QUYEN") return;
    expect(kq.thieu).toEqual(['SELECT trên view "app"."SettingN8n"']);
  });

  it("thiếu USAGE trên schema ⇒ cảnh báo", () => {
    const kq = phanLoaiQuyenN8n({ ...DU, coUsage: false });
    expect(kq.trangThai).toBe("THIEU_QUYEN");
    if (kq.trangThai !== "THIEU_QUYEN") return;
    expect(kq.thieu).toEqual(['USAGE trên schema "app"']);
  });

  it("role VẪN đọc được BẢNG Setting gốc ⇒ cảnh báo QUYỀN RỘNG kèm câu REVOKE (grant admin cấp, migration không gỡ được)", () => {
    const kq = phanLoaiQuyenN8n({ ...DU, coSelectBangGoc: true });
    expect(kq.trangThai).toBe("THIEU_QUYEN");
    if (kq.trangThai !== "THIEU_QUYEN") return;
    expect(kq.thieu.join(" ")).toContain("QUYỀN RỘNG");
    expect(kq.thieu.join(" ")).toContain('REVOKE ALL ON "app"."Setting"');
  });

  it("mất cả hai ⇒ nêu cả hai, không dừng ở cái đầu tiên", () => {
    const kq = phanLoaiQuyenN8n({ ...DU, coUsage: false, coSelect: false });
    if (kq.trangThai !== "THIEU_QUYEN") throw new Error("phải là THIEU_QUYEN");
    expect(kq.thieu).toHaveLength(2);
  });

  // View SettingN8n chưa tồn tại (migration chưa chạy / dump quá cũ) ⇒ `coSelect` là null. Hậu quả với n8n y hệt thiếu
  // quyền: node lấy khoá vẫn chết. Khác nguyên nhân, không khác kết cục ⇒ vẫn phải nổi cảnh báo.
  it("view kho khoá chưa tồn tại ⇒ vẫn cảnh báo, không im lặng cho qua", () => {
    expect(phanLoaiQuyenN8n({ ...DU, coSelect: null }).trangThai).toBe("THIEU_QUYEN");
  });

  it("database đuôi _test ⇒ IM, kể cả khi quyền thiếu sạch", () => {
    const kq = phanLoaiQuyenN8n({
      ...DU,
      database: "hogikids_test",
      coUsage: false,
      coSelect: false,
    });
    expect(kq.trangThai).toBe("KHONG_AP_DUNG");
  });

  it("cụm chưa có role ⇒ IM (không có quyền nào để mất)", () => {
    const kq = phanLoaiQuyenN8n({ ...DU, coRole: false, coUsage: null, coSelect: null });
    expect(kq.trangThai).toBe("KHONG_AP_DUNG");
  });

  it("câu cấp lại quyền dùng đúng tên role và schema đang xét", () => {
    const sql = cauCapLaiQuyen("app");
    expect(sql).toContain(`GRANT USAGE ON SCHEMA "app" TO ${N8N_RO_ROLE}`);
    expect(sql).toContain(`GRANT SELECT ON "app"."SettingN8n" TO ${N8N_RO_ROLE}`);
    // Cấp đúng 2 quyền, không rộng hơn: role này cố ý chỉ được đọc MỘT bảng.
    expect(sql.split("\n")).toHaveLength(2);
  });
});

describe("đọc quyền thật từ Postgres", () => {
  // Bộ test luôn chạy trên database đuôi _test (guard ở tests/setup.ts ép điều đó), nên lượt đọc
  // thật PHẢI ra KHONG_AP_DUNG. Đây chính là phép chứng minh "không báo động giả": nếu ai đó bỏ cửa
  // lọc database test, test này đỏ ngay thay vì để banner đỏ mọc lên giữa mọi lượt e2e.
  it("trên DB test ⇒ KHONG_AP_DUNG vì ĐÚNG LÝ DO là database test", async () => {
    const kq = await docQuyenDocN8n();
    expect(kq.trangThai).toBe("KHONG_AP_DUNG");
    if (kq.trangThai !== "KHONG_AP_DUNG") return;
    // Assert LÝ DO chứ không chỉ trạng thái. Hàm nuốt lỗi truy vấn và cũng trả KHONG_AP_DUNG, nên
    // chỉ so trạng thái là XANH GIẢ: câu SQL gõ sai vẫn qua được. Lý do nhắc đúng tên database
    // chứng minh truy vấn đã chạy thật và `current_database()` trả về giá trị.
    expect(kq.lyDo).toMatch(/_test là DB test/);
    expect(kq.lyDo).not.toMatch(/không đọc được quyền/);
  });
});
