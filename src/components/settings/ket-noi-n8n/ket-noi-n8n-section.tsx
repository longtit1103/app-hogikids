"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { caiWorkflowsN8n, kiemTraKetNoiN8n, luuKetNoiN8n } from "@/lib/actions/n8n-ket-noi";
import type { KetQuaKiemTra } from "@/lib/ket-noi/kiem-tra-types";
import type { TrangThaiKetNoiN8n } from "@/lib/n8n/provision/kiem-tra-va-trang-thai-n8n";
import type { KetQuaProvision } from "@/lib/n8n/provision/provision-n8n";

import { useUnsavedGuard } from "../use-unsaved-guard";

/**
 * Khối "Kết nối n8n": điền n8n URL + API key rồi MỘT nút đẩy cả 10 workflow của app vào n8n
 * (tạo credential, activate, kiểm chứng end-to-end) — người clone không phải import tay từng
 * file. API key là CHỈ-GHI như mọi khóa khác; nút Cài nói rõ nó sẽ GỬI khóa DB chỉ-đọc tới
 * đúng địa chỉ đã điền — gõ nhầm host là gửi nhầm chỗ, nên có nút Kiểm tra riêng chỉ-đọc.
 */
export function KetNoiN8nSection({ trangThai }: { trangThai: TrangThaiKetNoiN8n }) {
  const router = useRouter();
  const thieu = !trangThai.apiKeyDaLuu || !trangThai.n8nBaseUrl;
  const [mo, setMo] = useState(thieu);
  const [values, setValues] = useState<{ n8nBaseUrl: string; n8nWebhookPublicBase: string; n8nApiKey: string }>({
    n8nBaseUrl: "",
    n8nWebhookPublicBase: "",
    n8nApiKey: "",
  });
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [ketQuaKiemTra, setKetQuaKiemTra] = useState<KetQuaKiemTra | null>(null);
  const [ketQuaCai, setKetQuaCai] = useState<KetQuaProvision | null>(null);
  const [canXacNhan, setCanXacNhan] = useState<string[] | null>(null);

  const dirty = Object.values(values).some((v) => v.trim() !== "");
  useUnsavedGuard(dirty);

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await luuKetNoiN8n(values);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã lưu ${res.data.daLuu} giá trị kết nối n8n`);
      setValues({ n8nBaseUrl: "", n8nWebhookPublicBase: "", n8nApiKey: "" });
      // Kết quả cũ đo bộ cấu hình CŨ — giữ lại là nói dối về instance vừa đổi.
      setKetQuaKiemTra(null);
      setKetQuaCai(null);
      setCanXacNhan(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối mạng");
    } finally {
      setSaving(false);
    }
  }

  async function handleCheck() {
    setChecking(true);
    setKetQuaKiemTra(null);
    try {
      const res = await kiemTraKetNoiN8n();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setKetQuaKiemTra(res.data);
    } catch {
      toast.error("Kiểm tra thất bại — kiểm tra kết nối mạng");
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall(xacNhanDoiHaTang: boolean) {
    setInstalling(true);
    setCanXacNhan(null);
    try {
      const res = await caiWorkflowsN8n({ xacNhanDoiHaTang });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.data.loai === "can-xac-nhan") {
        setCanXacNhan(res.data.chiTiet);
        return;
      }
      setKetQuaCai(res.data.ketQua);
      const loi = res.data.ketQua.rows.filter((r) => r.hanhDong === "loi").length;
      if (loi === 0 && res.data.ketQua.probe.ok) toast.success("Đã cài đủ workflows — dây n8n → app thông.");
      else toast.warning(`Cài xong nhưng còn ${loi} dòng lỗi / probe chưa xanh — xem bảng bên dưới.`);
      router.refresh();
    } catch {
      toast.error("Cài workflows thất bại — kiểm tra kết nối mạng");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="rounded-lg border border-hairline">
      <button
        type="button"
        aria-expanded={mo}
        onClick={() => setMo((cu) => !cu)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/40"
      >
        <h3 className="min-w-0 truncate text-sm font-medium text-ink">Kết nối n8n (máy đồng bộ)</h3>
        <span className="flex shrink-0 items-center gap-2">
          {thieu ? (
            <Badge className="bg-warning/15 text-warning">Chưa cấu hình</Badge>
          ) : trangThai.soWorkflowDaCai > 0 ? (
            // "Đã ghi id" chứ không phải "đã cài xong": map id đếm cả dòng từng lỗi ở lượt trước.
            <Badge className="bg-success/15 text-success">Đã ghi id {trangThai.soWorkflowDaCai} workflow</Badge>
          ) : (
            <Badge className="bg-warning/15 text-warning">Chưa cài workflows</Badge>
          )}
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${mo ? "rotate-180" : ""}`} />
        </span>
      </button>

      <div className={mo ? "flex flex-col gap-3 px-4 pb-4" : "hidden"}>
        <p className="text-xs text-muted-foreground">
          n8n là máy kéo dữ liệu hằng đêm. Điền địa chỉ + API key (n8n → Settings → n8n API) rồi bấm
          &quot;Cài / cập nhật workflows&quot; — app tự đẩy 10 workflow vào, không phải import tay.
        </p>

        <ONhapGiaTri
          id="n8nBaseUrl"
          nhan="n8n URL (app gọi tới)"
          hienTai={trangThai.n8nBaseUrl || null}
          placeholder="http://hogikids-n8n:5678"
          value={values.n8nBaseUrl}
          onChange={(v) => setValues((cu) => ({ ...cu, n8nBaseUrl: v }))}
        />
        <ONhapGiaTri
          id="n8nWebhookPublicBase"
          nhan="n8n URL công khai (Pancake gọi tới)"
          hienTai={trangThai.n8nWebhookPublicBase || null}
          placeholder="https://n8n.ten-mien-cua-ban.com"
          value={values.n8nWebhookPublicBase}
          onChange={(v) => setValues((cu) => ({ ...cu, n8nWebhookPublicBase: v }))}
        />
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <label className="text-xs font-medium text-ink" htmlFor="n8nApiKey">n8n API key</label>
            {trangThai.apiKeyDaLuu ? (
              <span className="text-xs text-muted-foreground">Đã lưu{trangThai.apiKeyDuoi ? ` • đuôi …${trangThai.apiKeyDuoi}` : ""}</span>
            ) : (
              <span className="text-xs text-warning">Chưa có</span>
            )}
          </div>
          <Input
            id="n8nApiKey"
            type="password"
            autoComplete="off"
            placeholder={trangThai.apiKeyDaLuu ? "Dán key mới để thay (bỏ trống = giữ nguyên)" : "Dán API key từ n8n"}
            value={values.n8nApiKey}
            onChange={(e) => setValues((cu) => ({ ...cu, n8nApiKey: e.target.value }))}
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" disabled={checking || saving || installing} onClick={handleCheck}>
            {checking ? "Đang kiểm tra…" : "Kiểm tra n8n"}
          </Button>
          <Button type="button" disabled={!dirty || saving || installing} onClick={handleSave}>
            {saving ? "Đang lưu…" : "Lưu"}
          </Button>
          {/* `dirty` chặn ca gửi secret tới URL CŨ trong khi màn hình đang hiện URL mới chưa lưu. */}
          <Button type="button" variant="secondary" disabled={installing || saving || thieu || dirty} onClick={() => handleInstall(false)}>
            {installing ? "Đang cài…" : "Cài / cập nhật workflows"}
          </Button>
        </div>
        <p className="text-right text-xs text-muted-foreground">
          {dirty
            ? "Bấm Lưu trước — nút Cài dùng giá trị ĐÃ LƯU, không phải giá trị đang gõ."
            : "Nút Cài sẽ gửi khóa DB chỉ-đọc + khóa webhook tới đúng địa chỉ n8n phía trên — kiểm tra lại URL trước khi bấm."}
        </p>

        {ketQuaKiemTra ? (
          <ul className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs">
            {ketQuaKiemTra.dong.map((d) => (
              <li key={d.nhan} className={d.ok ? "text-success" : "text-error"}>
                {d.ok ? "✓" : "✕"} {d.nhan}: {d.chiTiet}
              </li>
            ))}
          </ul>
        ) : null}

        {canXacNhan ? (
          <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <p className="font-medium text-ink">Khóa hạ tầng trong kho sắp bị ghi đè (thường do đổi env khi deploy):</p>
            <ul className="list-inside list-disc">{canXacNhan.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => handleInstall(true)} disabled={installing}>
                Đồng ý đổi & cài tiếp
              </Button>
            </div>
          </div>
        ) : null}

        {ketQuaCai ? (
          <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs" data-testid="ket-qua-cai-workflows">
            {ketQuaCai.rows.map((r) => (
              <div key={r.slug} className={r.hanhDong === "loi" ? "text-error" : "text-ink"}>
                {r.hanhDong === "loi" ? "✕" : "✓"} {r.ten} — {r.hanhDong === "tao" ? "đã tạo" : r.hanhDong === "cap-nhat" ? "đã cập nhật" : r.loi}
                {r.hanhDong !== "loi" ? (r.active ? " · active" : " · chạy tay") : null}
              </div>
            ))}
            <div className={ketQuaCai.probe.ok ? "text-success" : "text-warning"}>
              {ketQuaCai.probe.ok ? "✓" : "⚠"} Kiểm chứng end-to-end: {ketQuaCai.probe.thongDiep}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Ô giá trị KHÔNG mật: hiện giá trị đang lưu, gõ đè để đổi (bỏ trống = giữ nguyên). */
function ONhapGiaTri({
  id, nhan, hienTai, placeholder, value, onChange,
}: {
  id: string;
  nhan: string;
  hienTai: string | null;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <label className="text-xs font-medium text-ink" htmlFor={id}>{nhan}</label>
        {hienTai ? (
          <span className="max-w-[60%] truncate text-xs text-muted-foreground">{hienTai}</span>
        ) : (
          <span className="text-xs text-warning">Chưa có</span>
        )}
      </div>
      <Input id={id} type="text" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
