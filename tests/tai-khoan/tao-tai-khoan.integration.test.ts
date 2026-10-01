import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `taoTaiKhoan` chạy THẬT trên DB test (unique `email` + unique `lower(email)` + partial unique OWNER).
 * Chỉ giả ngữ cảnh người gọi (`docNguoiDungPhien`) — cổng `congChuShopAction` vẫn là bản thật.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  return { ...that, docNguoiDungPhien: vi.fn() };
});

vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (importActual) => {
  const that = await importActual<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});

import { taoTaiKhoan } from "@/lib/actions/tai-khoan";
import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";
import { chuShopTrongDb, donDuLieuTaiKhoan, DUOI_EMAIL, staffGia } from "./du-lieu-tai-khoan-test";

const nhatKyThat = await vi.importActual<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>("@/lib/nhat-ky/ghi-nhat-ky");

const MAU_MAT_KHAU_TAM = /^[A-HJ-NP-Za-km-z2-9]{16}$/;

function formTao(p: { email: string; tenHienThi?: string; quyen?: string[]; them?: Record<string, string> }): FormData {
  const fd = new FormData();
  fd.set("email", p.email);
  fd.set("tenHienThi", p.tenHienThi ?? "Nhân viên thử");
  for (const q of p.quyen ?? []) fd.append("quyen", q);
  for (const [k, v] of Object.entries(p.them ?? {})) fd.set(k, v);
  return fd;
}

async function soDongUser(): Promise<number> {
  return prisma.user.count();
}

beforeEach(async () => {
  donKhoaPhucHoi();
  vi.mocked(ghiNhatKy).mockReset().mockImplementation(nhatKyThat.ghiNhatKy);
  await donDuLieuTaiKhoan();
  vi.mocked(docNguoiDungPhien).mockResolvedValue(await chuShopTrongDb());
});

afterAll(async () => {
  await donDuLieuTaiKhoan();
  await prisma.$disconnect();
});

describe("taoTaiKhoan", () => {
  it("(a) tạo OK: STAFF, phải đổi MK, email chuẩn hoá, quyền chuẩn hoá, MK tạm khớp hash, nhật ký không lộ MK", async () => {
    expect(dangPhucHoi()).toBe(false);
    const chuShop = await chuShopTrongDb();

    const res = await taoTaiKhoan(
      formTao({ email: `  Nhan.Vien${DUOI_EMAIL.toUpperCase()}  `, tenHienThi: "  Nhân viên A ", quyen: ["san-pham:sua", "ma-la"] }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { id, matKhauTam } = res.data;
    expect(matKhauTam).toMatch(MAU_MAT_KHAU_TAM);

    const dong = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(dong).toMatchObject({
      email: `nhan.vien${DUOI_EMAIL}`,
      tenHienThi: "Nhân viên A",
      role: "STAFF",
      mustChangePassword: true,
      isActive: true,
      quyen: ["san-pham:xem", "san-pham:sua"],
    });
    expect(await verifyPassword(matKhauTam, dong.passwordHash)).toBe(true);

    const nhatKy = await prisma.auditLog.findMany({ where: { hanhDong: "TAI_KHOAN_TAO" } });
    expect(nhatKy).toHaveLength(1);
    expect(nhatKy[0]).toMatchObject({
      ketQua: "OK",
      actorId: chuShop.id,
      actorEmail: chuShop.email,
      doiTuongLoai: "User",
      doiTuongId: id,
      doiTuongMoTa: `nhan.vien${DUOI_EMAIL}`,
    });
    expect(JSON.stringify(nhatKy)).not.toContain(matKhauTam);
    expect(JSON.stringify(nhatKy)).not.toContain(dong.passwordHash);
  });

  it("(b) email trùng khác hoa/thường + khoảng trắng ⇒ EMAIL_DA_DUNG, không thêm dòng", async () => {
    const dau = await taoTaiKhoan(formTao({ email: `anh${DUOI_EMAIL}` }));
    expect(dau.ok).toBe(true);
    const truoc = await soDongUser();

    const res = await taoTaiKhoan(formTao({ email: ` Anh${DUOI_EMAIL.toUpperCase()} ` }));

    expect(res).toMatchObject({ ok: false, code: "EMAIL_DA_DUNG", field: "email" });
    expect(await soDongUser()).toBe(truoc);
    // Thất bại action tài khoản ghi dòng LOI (spec §5), không lộ gì ngoài lý do.
    const loi = await prisma.auditLog.findMany({ where: { hanhDong: "TAI_KHOAN_TAO", ketQua: "LOI" } });
    expect(loi).toHaveLength(1);
    expect(loi[0]?.ghiChu).toEqual({ lyDo: "EMAIL_DA_DUNG" });
  });

  it("(b2) dòng đời cũ lưu email HOA (chỉ index lower(email) chặn được) ⇒ vẫn EMAIL_DA_DUNG", async () => {
    // Dòng legacy không chuẩn hoá — unique `email` thường KHÔNG va với bản chữ thường, chỉ index
    // `User_email_lower_key` chặn. Chứng minh action bắt cả lỗi từ unique index raw.
    await prisma.user.create({ data: { email: `Cu${DUOI_EMAIL}`, passwordHash: "x:y", role: "STAFF" } });
    const truoc = await soDongUser();

    const res = await taoTaiKhoan(formTao({ email: `cu${DUOI_EMAIL}` }));

    expect(res).toMatchObject({ ok: false, code: "EMAIL_DA_DUNG" });
    expect(await soDongUser()).toBe(truoc);
  });

  it("(c) Lãi/Lỗ thiếu quyền giá vốn ⇒ TO_HOP_QUYEN_SAI, không tạo", async () => {
    const truoc = await soDongUser();
    const res = await taoTaiKhoan(formTao({ email: `loi-lo${DUOI_EMAIL}`, quyen: ["tai-chinh-loi-lo:xem"] }));
    expect(res).toMatchObject({ ok: false, code: "TO_HOP_QUYEN_SAI", field: "quyen" });
    expect(await soDongUser()).toBe(truoc);
  });

  it("email sai định dạng ⇒ lỗi field email, không tạo", async () => {
    const truoc = await soDongUser();
    const res = await taoTaiKhoan(formTao({ email: "khong-phai-email" }));
    expect(res).toMatchObject({ ok: false, field: "email" });
    expect(await soDongUser()).toBe(truoc);
  });

  it.each(["", "   ", "\t\n "])("tên hiển thị rỗng/chỉ khoảng trắng (%j) ⇒ lỗi field tenHienThi, không tạo", async (ten) => {
    const truoc = await soDongUser();
    const res = await taoTaiKhoan(formTao({ email: `khong-ten${DUOI_EMAIL}`, tenHienThi: ten }));
    expect(res).toMatchObject({ ok: false, field: "tenHienThi" });
    expect(await soDongUser()).toBe(truoc);
  });

  it("thiếu hẳn trường tenHienThi ⇒ cũng bị từ chối", async () => {
    const fd = new FormData();
    fd.set("email", `thieu-ten${DUOI_EMAIL}`);
    const truoc = await soDongUser();
    expect(await taoTaiKhoan(fd)).toMatchObject({ ok: false, field: "tenHienThi" });
    expect(await soDongUser()).toBe(truoc);
  });

  it("nhật ký TAI_KHOAN_TAO ném ⇒ KHÔNG tạo tài khoản (nhật ký nằm TRONG transaction), trả lỗi lưu, không lộ MK", async () => {
    vi.mocked(ghiNhatKy).mockImplementation(async (db, p) => {
      if (p.hanhDong === "TAI_KHOAN_TAO") throw new Error("nhật ký hỏng");
      return nhatKyThat.ghiNhatKy(db, p);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const truoc = await soDongUser();
      const res = await taoTaiKhoan(formTao({ email: `nhat-ky-hong${DUOI_EMAIL}` }));
      expect(res.ok).toBe(false);
      expect(res).not.toHaveProperty("data");
      expect(await soDongUser()).toBe(truoc);
      expect(await prisma.user.findFirst({ where: { email: `nhat-ky-hong${DUOI_EMAIL}` } })).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("(d) STAFF gọi ⇒ KHONG_CO_QUYEN, không tạo", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(staffGia());
    const truoc = await soDongUser();
    const res = await taoTaiKhoan(formTao({ email: `bi-chan${DUOI_EMAIL}` }));
    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await soDongUser()).toBe(truoc);
  });

  it("(e) form gửi role=OWNER bị bỏ qua — tạo ra STAFF; INSERT OWNER thứ hai thẳng DB ⇒ index chặn", async () => {
    const res = await taoTaiKhoan(formTao({ email: `muon-lam-chu${DUOI_EMAIL}`, them: { role: "OWNER" } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: res.data.id } })).role).toBe("STAFF");

    await expect(
      prisma.$executeRaw`INSERT INTO "User" ("id","email","passwordHash","role")
        VALUES ('owner-thu-hai', ${`owner2${DUOI_EMAIL}`}, 'x:y', 'OWNER')`,
      // Prisma 7 (driver `pg`) đưa câu lỗi Postgres có TÊN ràng buộc, không đưa DETAIL "Key (role)=…".
    ).rejects.toThrow(/23505[\s\S]*unique constraint \\?"User_owner_duy_nhat\\?"/);
  });
});
