# Fixture dump cho cổng "dump đời trước phân quyền"

Tám bản dump THẬT (do `pg_dump` 15 sinh; 4 bản M1 + 4 bản "không phải backup của app") để test parser `src/lib/backup/kiem-migration-trong-dump.ts`
và — từ lượt nối cổng vào `runRestore`/route — test chặn phục hồi dump chụp trước migration phân quyền
`20260930170000_tai_khoan_phu_phan_quyen` (M1).

| File | Định dạng | Đời | Cổng phải |
|---|---|---|---|
| `truoc-m1.dump` | custom (`pg_dump -Fc -n app`, như backup prod) | mọi migration TRỪ M1 | chặn (`LoiBackupTruocPhanQuyen`) |
| `truoc-m1.sql.gz` | plain (`pg_dump -n app \| gzip -n -9`) | mọi migration TRỪ M1 | chặn |
| `sau-m1.dump` | custom | áp đủ M1 | cho qua |
| `sau-m1.sql.gz` | plain | áp đủ M1 | cho qua |
| `schema-khac.dump` | custom (`pg_dump -Fc -n khac`) | KHÔNG phải backup của app | chặn ở guard schema (400), KHÔNG phải 422 |
| `schema-khac.sql.gz` | plain (`pg_dump -n khac`) | KHÔNG phải backup của app | chặn ở guard schema (400) |
| `nhieu-schema.dump` | custom (`pg_dump -Fc -n app -n khac`) | `app._prisma_migrations` có M1 hoàn tất + schema lạ | chặn ở guard schema (400) TRƯỚC khoá/bản lùi |
| `nhieu-schema.sql.gz` | plain (`pg_dump -n app -n khac`) | như trên | chặn ở guard schema (400) |

Bốn file `schema-khac`/`nhieu-schema` khoá THỨ TỰ guard của cổng sớm route phục hồi: guard schema chạy
TRƯỚC cổng M1. Cả hai schema đều mang `_prisma_migrations` có M1 hoàn tất nên cổng M1 một mình hoặc nói
sai nguyên nhân (`schema-khac` ⇒ 422 "đời trước phân quyền") hoặc cho lọt (`nhieu-schema` ⇒ giành khoá,
chụp bản lùi, prune đẩy một bản lùi thật ra ngoài rồi mới 500).

**Checksum M1 trong `sau-m1.*` là của bản M1 CŨ** (trước khi thêm `SET LOCAL lock_timeout`, 01/10). KHÔNG
cần sinh lại: parser `kiem-migration-trong-dump.ts` chỉ đọc `migration_name`/`finished_at`/`rolled_back_at`,
không đọc `checksum`; và route phục hồi không chạy `migrate`.

## Dữ liệu — CHỈ tổng hợp

Sinh trên DB dùng-một-lần (tên tận cùng `_fixture_test`, schema `app`), KHÔNG BAO GIỜ dump từ DB thật:

- `User`: 1 dòng `FX-user-owner` / `owner@fixture.test` / hash giả `FX-khong-phai-hash` / shop `Shop Fixture`
  (bản `sau-m1` đã được M1 nâng `role = OWNER`, copy `sessionEpoch`, tạo `ShopProfile` id 1).
- `Setting`: 1 dòng `sessionEpoch = 1727000000000`.
- `Order`: 2 đơn giả `FX-don-1`, `FX-don-2` (kênh `direct`).
- Dữ liệu tham chiếu do chính migration chèn: kênh `direct`, danh mục chi phí `interest`. Các migration
  seed shop id/credential chỉ chạy khi DB đã có `RawPancakeOrder` ⇒ DB fixture trắng không nhận gì.

## Sinh lại

```bash
# Postgres 15 (client + server) — container app/CI dùng pg_restore 15; dump của pg_dump mới hơn không đọc được.
FIXTURE_DB_URL=postgresql://USER:PASS@HOST:PORT/<ten>_fixture_test \
PG_BIN=/duong/dan/postgresql@15/bin \
bash tests/fixtures/backup/sinh-fixture.sh              # 4 fixture M1
# … sinh-fixture.sh schema-khac                         # CHỈ 4 fixture schema-khac/nhieu-schema
```

Chế độ `schema-khac`: dựng schema `app` chỉ gồm `_prisma_migrations` (1 dòng M1 hoàn tất, id `FX-mig-app`)
+ schema `khac` (`_prisma_migrations` 1 dòng M1, bảng `GhiChu` 1 dòng `FX-khong-phai-backup-cua-app`),
dump rồi `DROP SCHEMA khac`. Checksum trong 2 bảng là `repeat('f', 64)` (giả). Kiểm toàn văn 01/10/2026
(pg_dump 15.19): `schema-khac.*` 103 dòng, `nhieu-schema.*` 147 dòng — 0 email, 0 SĐT, 0 shop id thật,
`\restrict`/`\unrestrict` 2 dòng.

Script: DROP/CREATE schema `app` (cổng: DB phải tận cùng `_fixture_test`, pg_dump/pg_restore/server đều
bản 15) → `prisma migrate deploy` bộ migrations bỏ M1 (thư mục tạm) → chèn dữ liệu tổng hợp → dump
`truoc-m1` → áp đủ M1 → dump `sau-m1` → **tự kiểm toàn văn** → in SHA-256.

Hash KHÔNG tái lập được giữa hai lượt sinh (dump chứa mốc giờ `_prisma_migrations`, uuid dòng migration,
khoá `\restrict` ngẫu nhiên) — sinh lại là đổi cả 4 hash: cập nhật bảng dưới + `BINARY_MANIFEST` trong
`scripts/publish-public-snapshot.sh`, rồi chạy `bash scripts/publish-public-snapshot.sh --chi-kiem-allowlist`.

`.gitignore` chặn `*.dump`/`*.sql.gz` toàn repo (chống lỡ commit backup THẬT) — 4 file này được theo dõi
bằng `git add -f` có chủ đích; đã tracked thì sinh lại chỉ cần `git add` thường. KHÔNG nới `.gitignore`.

## Kiểm toàn văn (30/09/2026, pg_dump/pg_restore 15.19)

Bung TRỌN mỗi file ra SQL không nối DB (`pg_restore -f - x.dump`, `gunzip -c y.sql.gz`), trên toàn văn:

| File | Dòng SQL | Email | SĐT VN `0xxxxxxxxx` | Shop id thật | `pancakeId` | `\restrict`/`\unrestrict` |
|---|---|---|---|---|---|---|
| `truoc-m1.dump` | 2643 | chỉ `owner@fixture.test` | 0 | 0 | toàn `FX-` | có (2 dòng, pg_restore 15.19 tự in) |
| `sau-m1.dump` | 2772 | chỉ `owner@fixture.test` | 0 | 0 | toàn `FX-` | có (2 dòng, pg_restore 15.19 tự in) |
| `truoc-m1.sql.gz` | 2643 | chỉ `owner@fixture.test` | 0 | 0 | toàn `FX-` | **có trong file** (2 dòng) |
| `sau-m1.sql.gz` | 2772 | chỉ `owner@fixture.test` | 0 | 0 | toàn `FX-` | **có trong file** (2 dòng) |

- SĐT: đếm SAU khi gột token 64-hex. Lý do: checksum SHA-256 của migration `20260714170000_rename_raw_tiktok_shop`
  trong `_prisma_migrations` chứa một chuỗi con 10 chữ số bắt đầu bằng 0 (khớp mẫu SĐT) — dương tính giả, đã soi tay.
- Đã soi bằng mắt mọi khối `COPY` có dữ liệu (ngoài `_prisma_migrations`): `Channel` (direct), `ExpenseCategory`
  (interest), `Order` (2 đơn FX), `Setting` (sessionEpoch), `User` (owner fixture), `ShopProfile` (chỉ bản sau M1).
- **`\restrict`:** `pg_dump` 15.19 (≥ 15.14) GHI `\restrict <khoá>` đầu file và `\unrestrict <khoá>` cuối file
  plain. Cổng plain-SQL của lượt nối vào `runRestore` (`assertPlainSqlOnlySchema`) phải cho qua đúng hai dòng này.

## SHA-256 (khai trong `BINARY_MANIFEST`)

```
6a2050566c86d88b685064f65823576fe60be572d36df59354c4410f908b1d4b  tests/fixtures/backup/truoc-m1.dump
56d689e7f4de2b048fee57655ef7d24d3b16d03ba506c6805fef6b307edfa208  tests/fixtures/backup/truoc-m1.sql.gz
c5a17133b76a02d8cbbfe62cb91b60e0ce2c4dff55efa03f5a49916948e06290  tests/fixtures/backup/sau-m1.dump
0dfb95f34acec192dfd315bcf9caf782f8ff29a456169062ced8c9671909dc28  tests/fixtures/backup/sau-m1.sql.gz
481d4ba461445abcea51a85dc751dbd82804cff28bfd903f9019adca74cedb8c  tests/fixtures/backup/schema-khac.dump
b1b2421b2a6e76a787df7da043155417f637b3ddaafc3c824980f6c947f6cffc  tests/fixtures/backup/schema-khac.sql.gz
e950e7ab505841746862df8372a4117ab79d22ac807d4310263ec6f23dabba10  tests/fixtures/backup/nhieu-schema.dump
5567f54f5de12599cf93bc2ecb32158f6084877a1c42b209f053d33656134fef  tests/fixtures/backup/nhieu-schema.sql.gz
```
