"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

import { DialogDatLaiMatKhau } from "./dialog-dat-lai-mat-khau";
import { DialogKhoaMo } from "./dialog-khoa-mo";
import { DialogXoa } from "./dialog-xoa";
import { formatGioVn } from "./gio-vn";
import { ModalSuaQuyen } from "./modal-sua-quyen";
import { ModalTaoTaiKhoan } from "./modal-tao-tai-khoan";

/** Hình dữ liệu từ `listTaiKhoan` — `lastLoginAt` qua ranh giới server→client vẫn là Date. */
export type DongTaiKhoan = {
  id: string;
  email: string;
  tenHienThi: string;
  role: "OWNER" | "STAFF";
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  quyen: Quyen[];
};

type HanhDong = "sua-quyen" | "khoa-mo" | "dat-lai" | "xoa";

function TrangThai({ row }: { row: DongTaiKhoan }) {
  if (row.role === "OWNER") return <Badge>Chủ shop</Badge>;
  if (!row.isActive) return <Badge variant="destructive">Khoá</Badge>;
  if (row.mustChangePassword) return <Badge variant="outline">Chờ đổi MK</Badge>;
  return <Badge variant="secondary">Hoạt động</Badge>;
}

function MenuHanhDong({ row, chon }: { row: DongTaiKhoan; chon: (h: HanhDong) => void }) {
  // Chủ shop bất khả xâm phạm: không có menu thao tác (server cũng từ chối).
  if (row.role === "OWNER") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Thao tác với ${row.email}`}
        className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-surface-soft"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => chon("sua-quyen")}>Sửa quyền</DropdownMenuItem>
        <DropdownMenuItem onClick={() => chon("khoa-mo")}>{row.isActive ? "Khoá" : "Mở khoá"}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => chon("dat-lai")}>Đặt lại mật khẩu</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => chon("xoa")}>
          Xoá
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BangTaiKhoan({ rows }: { rows: DongTaiKhoan[] }) {
  const [dangChon, setDangChon] = useState<{ row: DongTaiKhoan; hanhDong: HanhDong } | null>(null);
  const dong = () => setDangChon(null);
  const moCho = (h: HanhDong) => (dangChon?.hanhDong === h ? dangChon.row : null);

  const suaQuyen = moCho("sua-quyen");
  const khoaMo = moCho("khoa-mo");
  const datLai = moCho("dat-lai");
  const xoa = moCho("xoa");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{rows.length} tài khoản</p>
        <ModalTaoTaiKhoan />
      </div>

      {/* Máy tính: bảng. */}
      <div className="hidden overflow-x-auto rounded-xl border border-hairline md:block">
        <table className="w-full text-sm">
          <thead className="bg-surface-soft text-left text-xs font-medium text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Tên</th>
              <th className="px-3 py-2">Trạng thái</th>
              <th className="px-3 py-2">Đăng nhập cuối</th>
              <th className="px-3 py-2 text-right">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-hairline" data-testid="dong-tai-khoan">
                <td className="px-3 py-2 text-ink">{r.email}</td>
                <td className="px-3 py-2 text-ink">{r.tenHienThi}</td>
                <td className="px-3 py-2">
                  <TrangThai row={r} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatGioVn(r.lastLoginAt)}</td>
                <td className="px-3 py-2 text-right">
                  <MenuHanhDong row={r} chon={(h) => setDangChon({ row: r, hanhDong: h })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Điện thoại: danh sách thẻ. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-2 rounded-xl border border-hairline bg-surface-card p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-medium text-ink">{r.email}</span>
              <span className="truncate text-xs text-muted-foreground">{r.tenHienThi}</span>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <TrangThai row={r} />
                <span className="text-xs text-muted-foreground">Cuối: {formatGioVn(r.lastLoginAt)}</span>
              </div>
            </div>
            <MenuHanhDong row={r} chon={(h) => setDangChon({ row: r, hanhDong: h })} />
          </li>
        ))}
      </ul>

      {rows.length === 0 && <p className="text-sm text-muted-foreground">Chưa có tài khoản nào.</p>}

      {suaQuyen && (
        <ModalSuaQuyen
          key={suaQuyen.id}
          id={suaQuyen.id}
          email={suaQuyen.email}
          quyenHienTai={suaQuyen.quyen}
          mo
          onDong={dong}
        />
      )}
      {khoaMo && (
        <DialogKhoaMo key={khoaMo.id} id={khoaMo.id} email={khoaMo.email} dangHoatDong={khoaMo.isActive} mo onDong={dong} />
      )}
      {datLai && <DialogDatLaiMatKhau key={datLai.id} id={datLai.id} email={datLai.email} mo onDong={dong} />}
      {xoa && <DialogXoa key={xoa.id} id={xoa.id} email={xoa.email} mo onDong={dong} />}
    </div>
  );
}
