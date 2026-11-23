import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRONZE_STREAMS } from "@/lib/bronze/streams";
import { THU_TU_PHIEN_BAN_DON_SQL } from "@/lib/bronze/thu-tu-phien-ban-don";
import { BANG_LAN_THAY } from "@/lib/bronze/transform-raw-helpers";

/**
 * LƯỚI TĨNH cho thứ tự phiên bản đơn Pancake (`RawPancakeOrder`) — ba bất biến đi cùng nhau:
 *
 *  1. MỌI bộ chọn "bản đứng đầu" của đơn Pancake (`DISTINCT ON`, `row_number() OVER`, `… LIMIT 1`) xếp bằng ĐÚNG mảnh
 *     chung `thuTuPhienBanDon` / `THU_TU_PHIEN_BAN_DON_SQL`, và mảnh đó xếp `fetchedAt → landSeq → id`. Một bộ đọc tự
 *     xếp `"fetchedAt" DESC, "id" DESC` là quay về để uuid ngẫu nhiên phân xử khi trùng mili-giây — đường dựng chọn
 *     bản A trong khi sổ kết cục chờ dấu trên bản B.
 *  2. MỌI lượt chèn `RawPancakeOrder` nằm trong transaction đã gọi `giuKhoaLandDon(tx)` TRƯỚC: `landSeq` cấp theo thứ
 *     tự INSERT, không theo thứ tự COMMIT — ngoài khoá thì lượt INSERT sau mà COMMIT trước vẫn mang số lớn hơn.
 *     Đường chèn duy nhất là `landRaw` (stream có `table === "RawPancakeOrder"`); không có câu chèn thô / ORM nào khác.
 *  3. CAS ghi Silver (`upsertOneOrder`) không so `rawFetchedAt` ĐƠN LẺ — phải đi cặp `rawLandSeq`.
 *
 * Tự quét `src/` + `scripts/` (không khai tay file), fail-closed: đường mới không khớp mẫu đã biết là ĐỎ.
 *
 * Phủ ĐỘNG (ép trùng mốc + uuid ngược, `trung-moc-land-don-pancake-ban-land-sau-thang.test.ts`): `latestPayloads`,
 * dựng Silver + đóng dấu bản dưới, `locDonChuaDongDau`, `ketCucHienTaiCuaDon`, `demCanXem`, `dongDauCacBanCuChuaDongDau`,
 * `laSuKienCuHon`, `doiChieuDonKhoVsSan`. CHỈ được lưới TĨNH này phủ (cùng mảnh chung, chưa có ca động riêng):
 * `locDonQuaHanChuaDongDau`, `demTonDong`, `dsDonCanXem`, `locDonLegacy` (`ket-cuc-silver.ts`), `khaoSatLegacy`
 * (`backfill-ket-cuc-legacy.ts`), `scripts/bu-don-shopee-tu-don-kho.ts`.
 */

const GOC = resolve(fileURLToPath(import.meta.url), "../../..");
const THU_MUC_QUET = ["src", "scripts"];
const BO_QUA = new Set(["node_modules", "." + "next", "dist", "coverage", "generated"]);
const FILE_MANH_CHUNG = "src/lib/bronze/thu-tu-phien-ban-don.ts";
/**
 * File có câu `DISTINCT ON` trên bảng NỘI SUY mà không bao giờ chạy cho đơn Pancake — kèm lý do kiểm được (test dưới
 * khẳng định điều kiện). `landRaw` → `ghiLanThayLai` chỉ gọi khi bảng thuộc `BANG_LAN_THAY`.
 */
const NOI_SUY_KHONG_PHAI_DON = new Set(["src/lib/bronze/land-raw.ts"]);
const BANG = "RawPancakeOrder";

function lietKeFile(thuMuc: string): string[] {
  const ket: string[] = [];
  for (const muc of readdirSync(thuMuc, { withFileTypes: true })) {
    if (BO_QUA.has(muc.name)) continue;
    const duong = join(thuMuc, muc.name);
    if (muc.isDirectory()) ket.push(...lietKeFile(duong));
    else if (/\.(ts|tsx|mts|sql)$/.test(muc.name)) ket.push(duong);
  }
  return ket;
}

const dongCua = (s: string, viTri: number) => s.slice(0, viTri).split("\n").length;
/** Vị trí nằm trên dòng chú thích (`//`, `*`, `/*`) — chú thích nhắc tên hàm/mẫu SQL không phải mã chạy. */
const trongChuThich = (s: string, viTri: number) => /^\s*(?:\/\/|\*|\/\*)/.test(s.slice(s.lastIndexOf("\n", viTri - 1) + 1, viTri));
const BANG_RAW = /\b(?:FROM|JOIN)\s+(?:\w+\.)?"(Raw[A-Za-z]+|\$\{[^}]+\})"/g;
const MANH_THU_TU = /\$\{\s*(?:thuTuPhienBanDon|THU_TU_PHIEN_BAN_DON_SQL)\s*\}/;

/**
 * Bộ chọn bản đứng đầu của `RawPancakeOrder` không dùng mảnh chung. `DISTINCT ON` / `row_number()` lấy bảng `FROM` GẦN
 * NHẤT phía SAU (trong 400 ký tự); `LIMIT 1` lấy bảng GẦN NHẤT phía TRƯỚC. Bảng nội suy (`"${table}"`, chính
 * `latestPayloads`) ⇒ file phải nhắc `THU_TU_PHIEN_BAN_DON_SQL`. Thuần — để test tự kiểm bằng mẫu.
 */
function boChonKhongDungManhChung(noiDung: string, boQuaBangNoiSuy = false): string[] {
  const cacBang = [...noiDung.matchAll(BANG_RAW)].map((m) => ({ viTri: m.index ?? 0, bang: m[1] }));
  const ket: string[] = [];
  const kiem = (viTri: number, bang: string | undefined, vung: string) => {
    if (bang === BANG && !MANH_THU_TU.test(vung)) ket.push(`${BANG} @ dòng ${dongCua(noiDung, viTri)}`);
    if (bang?.startsWith("${") && !boQuaBangNoiSuy && !noiDung.includes("THU_TU_PHIEN_BAN_DON_SQL")) {
      ket.push(`bảng nội suy không nhắc THU_TU_PHIEN_BAN_DON_SQL @ dòng ${dongCua(noiDung, viTri)}`);
    }
  };
  for (const m of noiDung.matchAll(/DISTINCT ON|row_number\(\)\s*OVER/g)) {
    const viTri = m.index ?? 0;
    if (trongChuThich(noiDung, viTri)) continue;
    const sau = cacBang.find((b) => b.viTri > viTri && b.viTri - viTri < 400);
    kiem(viTri, sau?.bang, noiDung.slice(viTri, viTri + 700));
  }
  for (const m of noiDung.matchAll(/\bLIMIT 1\b/g)) {
    const viTri = m.index ?? 0;
    if (trongChuThich(noiDung, viTri)) continue;
    const truoc = cacBang.filter((b) => b.viTri < viTri && viTri - b.viTri < 400).pop();
    kiem(viTri, truoc?.bang, noiDung.slice(truoc?.viTri ?? viTri, viTri));
  }
  // ORM xếp bản theo `fetchedAt` trên model đơn — cũng là một bộ chọn bản riêng.
  for (const m of noiDung.matchAll(/\.rawPancakeOrder\.(?:findFirst|findFirstOrThrow|findMany)\(\{[^]*?\}\)/g)) {
    if (/orderBy[^]*fetchedAt/.test(m[0])) ket.push(`ORM rawPancakeOrder xếp theo fetchedAt @ dòng ${dongCua(noiDung, m.index ?? 0)}`);
  }
  return ket;
}

/** Đối số thứ `i` (đếm từ 0) của lời gọi bắt đầu ở `batDau` (vị trí NGAY SAU dấu `(`), tách theo dấu phẩy cấp ngoài. */
function cacDoiSo(noiDung: string, batDau: number): string[] {
  const ket: string[] = [];
  let sau = 0;
  let hienTai = "";
  for (let i = batDau; i < noiDung.length; i++) {
    const c = noiDung[i];
    if ("([{".includes(c)) sau++;
    if (")]}".includes(c)) {
      if (sau === 0) break;
      sau--;
    }
    if (c === "," && sau === 0) {
      ket.push(hienTai.trim());
      hienTai = "";
    } else hienTai += c;
  }
  if (hienTai.trim()) ket.push(hienTai.trim());
  return ket;
}

const STREAM_DON = new Set(
  Object.entries(BRONZE_STREAMS)
    .filter(([, s]) => s.table === BANG)
    .map(([ten]) => ten),
);

/**
 * Lời gọi `landRaw(` có thể chèn `RawPancakeOrder` mà KHÔNG chắc nằm dưới khoá land đơn. Một lời gọi được coi là
 * DƯỚI KHOÁ khi: đối số `db` (thứ 5) là `tx`, và trong 600 ký tự phía trước có `giuKhoaLandDon(tx)` (cùng callback
 * `$transaction`). Stream là chuỗi literal không phải stream đơn ⇒ không chèn đơn. Stream ĐỘNG (biến) ngoài khoá
 * chỉ được chấp nhận khi phía trước có nhánh `<biến> === "orders"` đã đi đường dưới khoá (khuôn `/api/ingest/raw`).
 */
function landRawNgoaiKhoa(noiDung: string): string[] {
  const ket: string[] = [];
  for (const m of noiDung.matchAll(/\blandRaw\(/g)) {
    const viTri = m.index ?? 0;
    if (trongChuThich(noiDung, viTri)) continue;
    const truocDo = noiDung.slice(Math.max(0, viTri - 25), viTri);
    if (/function\s+$/.test(truocDo)) continue; // chính định nghĩa hàm
    const doiSo = cacDoiSo(noiDung, viTri + m[0].length);
    const stream = doiSo[0] ?? "";
    const literal = stream.match(/^["'`]([^"'`]+)["'`]$/)?.[1];
    if (literal !== undefined && !STREAM_DON.has(literal)) continue;
    const phiaTruoc = noiDung.slice(Math.max(0, viTri - 600), viTri);
    const duoiKhoa = doiSo[4] === "tx" && /giuKhoaLandDon\(tx\)/.test(phiaTruoc);
    if (duoiKhoa) continue;
    if (literal === undefined && /^\w+$/.test(stream)) {
      const nhanh = new RegExp(`\\b${stream}\\s*===\\s*"orders"[^]*giuKhoaLandDon\\(tx\\)[^]*landRaw\\(${stream},[^)]*\\btx\\b`);
      if (nhanh.test(phiaTruoc) && [...STREAM_DON].every((s) => s === "orders")) continue;
    }
    ket.push(`landRaw(${stream}, …) ngoài khoá land đơn @ dòng ${dongCua(noiDung, viTri)}`);
  }
  // Câu chèn thô / ORM vào bảng đơn ngoài `landRaw` — không có đường nào hợp lệ.
  for (const m of noiDung.matchAll(/INSERT\s+INTO\s+(?:\w+\.)?"RawPancakeOrder"|\.rawPancakeOrder\.(?:create|createMany|upsert)\(/g)) {
    ket.push(`chèn RawPancakeOrder ngoài landRaw @ dòng ${dongCua(noiDung, m.index ?? 0)}`);
  }
  return ket;
}

function quet(kiem: (noiDung: string, ten: string) => string[]): string[] {
  const viPham: string[] = [];
  for (const thuMuc of THU_MUC_QUET) {
    for (const file of lietKeFile(join(GOC, thuMuc))) {
      const ten = relative(GOC, file);
      if (ten === FILE_MANH_CHUNG) continue;
      for (const v of kiem(readFileSync(file, "utf8"), ten)) viPham.push(`${ten}: ${v}`);
    }
  }
  return viPham;
}

describe("lưới thứ tự phiên bản + khoá land đơn Pancake", () => {
  it("mảnh thứ tự chung xếp updated_at → fetchedAt → landSeq → id", () => {
    expect(THU_TU_PHIEN_BAN_DON_SQL).toBe(`"pbDon".moc DESC NULLS LAST, "fetchedAt" DESC, "landSeq" DESC, "id" DESC`);
  });

  it("mọi bộ chọn bản đứng đầu của RawPancakeOrder dùng mảnh chung (src + scripts)", () => {
    expect(BANG_LAN_THAY.has(BANG)).toBe(false); // điều kiện của NOI_SUY_KHONG_PHAI_DON
    expect(
      quet((noiDung, ten) => boChonKhongDungManhChung(noiDung, NOI_SUY_KHONG_PHAI_DON.has(ten))),
      "dùng thuTuPhienBanDon/THU_TU_PHIEN_BAN_DON_SQL",
    ).toEqual([]);
  });

  it("mọi đường chèn RawPancakeOrder nằm dưới giuKhoaLandDon (src + scripts)", () => {
    expect(STREAM_DON).toEqual(new Set(["orders"]));
    expect(quet((noiDung) => landRawNgoaiKhoa(noiDung))).toEqual([]);
  });

  it("landRaw xếp INSERT đơn Pancake theo thứ tự phần tử trong trang", () => {
    const landRaw = readFileSync(join(GOC, "src/lib/bronze/land-raw.ts"), "utf8");
    expect(landRaw).toMatch(/table === "RawPancakeOrder"/);
    expect(landRaw).toMatch(/WITH ORDINALITY AS x\(elem, thu_tu\)/);
    expect(landRaw).toMatch(/ORDER BY x\.thu_tu/);
  });

  it("CAS ghi Silver đơn không so rawFetchedAt đơn lẻ — luôn đi cặp rawLandSeq", () => {
    const upsert = readFileSync(join(GOC, "src/lib/ingest/pancake-upsert.ts"), "utf8");
    expect(upsert).not.toMatch(/rawFetchedAt:\s*\{\s*lte:/);
    expect(upsert).toMatch(/rawFetchedAt:\s*\{\s*lt:\s*mocNguon\.fetchedAt\s*\}/);
    expect(upsert).toMatch(/rawFetchedAt:\s*mocNguon\.fetchedAt,\s*OR:\s*\[\{\s*rawLandSeq:\s*null\s*\},\s*\{\s*rawLandSeq:\s*\{\s*lte:\s*mocNguon\.landSeq/);
    expect(upsert).toMatch(/rawLandSeq:\s*mocNguon\?\.landSeq\s*\?\?\s*null/);
  });

  it("tự kiểm: mẫu vi phạm bị bắt, mẫu đúng thì không", () => {
    const sai = 'SELECT DISTINCT ON ("shopId","externalId") id FROM "RawPancakeOrder" ORDER BY "shopId","externalId","fetchedAt" DESC, "id" DESC';
    expect(boChonKhongDungManhChung(sai)).toHaveLength(1);
    const dung = 'SELECT DISTINCT ON ("shopId","externalId") id FROM "RawPancakeOrder" ${noiMocPhienBanDon} ORDER BY "shopId","externalId", ${thuTuPhienBanDon}';
    expect(boChonKhongDungManhChung(dung)).toEqual([]);
    expect(boChonKhongDungManhChung('SELECT payload FROM "RawPancakeOrder" WHERE x ORDER BY "fetchedAt" DESC LIMIT 1')).toHaveLength(1);
    expect(boChonKhongDungManhChung('SELECT payload FROM "RawPancakeOrder" ${NOI} WHERE x ORDER BY ${THU_TU_PHIEN_BAN_DON_SQL} LIMIT 1')).toEqual([]);
    expect(boChonKhongDungManhChung('row_number() OVER (ORDER BY "fetchedAt" DESC) AS h FROM "RawPancakeOrder"')).toHaveLength(1);
    expect(boChonKhongDungManhChung('SELECT DISTINCT ON ("externalId") x FROM "RawPancakeProduct" ORDER BY "fetchedAt" DESC')).toEqual([]);
    expect(boChonKhongDungManhChung("prisma.rawPancakeOrder.findFirst({ where: {}, orderBy: { fetchedAt: \"desc\" } })")).toHaveLength(1);

    expect(landRawNgoaiKhoa(`await landRaw("orders", shop, env);`)).toHaveLength(1);
    expect(landRawNgoaiKhoa(`await landRaw("products", shop, env);`)).toEqual([]);
    expect(landRawNgoaiKhoa(`async (tx) => { await giuKhoaLandDon(tx); return landRaw("orders", s, e, undefined, tx, ids); }`)).toEqual([]);
    expect(landRawNgoaiKhoa(`async (tx) => { await giuKhoaLandDon(tx); return landRaw("orders", s, e, undefined, prisma); }`)).toHaveLength(1);
    expect(landRawNgoaiKhoa(`await landRaw(stream, s, p, id, undefined, ids);`)).toHaveLength(1);
    const nhanhDung = `stream === "orders" ? await prisma.$transaction(async (tx) => { await giuKhoaLandDon(tx); return landRaw(stream, s, p, id, tx, ids); }) : await landRaw(stream, s, p, id, undefined, ids, ngay);`;
    expect(landRawNgoaiKhoa(nhanhDung)).toEqual([]);
    expect(landRawNgoaiKhoa(`await tx.$executeRaw\`INSERT INTO "RawPancakeOrder" (id) VALUES (1)\``)).toHaveLength(1);
    expect(landRawNgoaiKhoa(`await prisma.rawPancakeOrder.create({ data })`)).toHaveLength(1);
  });
});
