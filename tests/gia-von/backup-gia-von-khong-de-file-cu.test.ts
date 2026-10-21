import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ghiBackupVaXacMinh,
  tenFileBackupGiaVon,
  type NoiDungBackup,
} from "@/lib/gia-von/ghi-gia-von-theo-pancake";

/**
 * Backup giá vốn là ĐƯỜNG LÙI DUY NHẤT khi lượt ghi đè số chủ shop nhập tay. Hai lượt áp trong
 * cùng một phút (bấm nút hai lần, hoặc nút + CLI) từng đặt CÙNG một tên file theo phút và ghi đè
 * nhau: bản chụp giá gốc của lượt đầu biến mất, chỉ còn giá ĐÃ áp của lượt sau — không hoàn nguyên
 * được nữa. Hai lời hứa: tên file không trùng trong cùng phút, và file đã có thì KHÔNG BAO GIỜ bị đè.
 */

let thuMuc: string;

const noiDung = (costPriceCu: number, costPriceMoi: number): NoiDungBackup => ({
  ghiLuc: "2026-10-21T07:30:00.000Z",
  cheDo: "theo-pancake",
  soDong: 1,
  dong: [{ variantId: "v1", sku: "SKU-1", ten: "Áo · M", costPriceCu, costPriceMoi }],
});

beforeAll(() => {
  thuMuc = mkdtempSync(path.join(tmpdir(), "backup-gia-von-khong-de-"));
});
afterAll(() => {
  rmSync(thuMuc, { recursive: true, force: true });
});

describe("tenFileBackupGiaVon", () => {
  it("cùng một mốc (cùng phút, cùng giây) vẫn ra HAI tên khác nhau", () => {
    const moc = new Date(2026, 9, 21, 14, 30, 5, 123);

    const a = tenFileBackupGiaVon(moc, "theo-pancake", "-app.json");
    const b = tenFileBackupGiaVon(moc, "theo-pancake", "-app.json");

    expect(a).not.toBe(b);
  });

  it("tên mang đủ ngày-giờ-phút-giây-mili giây, chế độ và đuôi", () => {
    const moc = new Date(2026, 9, 21, 14, 30, 5, 7);

    const ten = tenFileBackupGiaVon(moc, "chi-thieu", ".json");

    expect(ten).toMatch(/^backup-gia-von-261021-143005-007-[0-9a-f]{6}-chi-thieu\.json$/);
  });

  it("hai lượt trong cùng phút ghi ra HAI file, bản đầu còn nguyên giá gốc", () => {
    const moc = new Date(2026, 9, 21, 14, 30, 0, 0);
    const p1 = path.join(thuMuc, tenFileBackupGiaVon(moc, "theo-pancake", "-app.json"));
    const p2 = path.join(thuMuc, tenFileBackupGiaVon(moc, "theo-pancake", "-app.json"));

    ghiBackupVaXacMinh(p1, noiDung(120_000, 90_000));
    ghiBackupVaXacMinh(p2, noiDung(90_000, 85_000));

    expect(readdirSync(thuMuc).filter((f) => f.endsWith("-app.json"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(p1, "utf8")).dong[0].costPriceCu).toBe(120_000);
  });
});

describe("ghiBackupVaXacMinh — không bao giờ đè file đã có", () => {
  it("đường dẫn đã có file ⇒ TỪ CHỐI ghi DB, file cũ giữ nguyên từng byte", () => {
    const p = path.join(thuMuc, "da-co.json");
    const cu = JSON.stringify(noiDung(120_000, 90_000));
    writeFileSync(p, cu, "utf8");

    expect(() => ghiBackupVaXacMinh(p, noiDung(90_000, 85_000))).toThrow(/TỪ CHỐI ghi DB/);
    expect(readFileSync(p, "utf8")).toBe(cu);
  });
});
