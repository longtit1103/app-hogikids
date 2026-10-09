/** Ô form có nhãn + dòng lỗi đỏ — dùng chung cho các form khối Nợ phải trả. */
export function OCoNhan({
  id,
  nhan,
  loi,
  ghiChu,
  children,
}: {
  id: string;
  nhan: string;
  loi?: string;
  ghiChu?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {nhan}
      </label>
      {children}
      {ghiChu && <p className="text-xs text-muted-foreground">{ghiChu}</p>}
      {loi && <p className="text-xs text-error">{loi}</p>}
    </div>
  );
}
