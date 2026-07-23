"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { friendlyOwnerApiError, OwnerApiError } from "../../lib/browser-owner-api";
import { requestOwnerAccountExport } from "../../lib/owner-account-export-download";

function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

export function AccountDataExportPanel() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  async function exportData() {
    setMessage(null);
    setPending(true);
    try {
      const download = await requestOwnerAccountExport();
      downloadJson(download.filename, download.json);
      setMessage({
        kind: "success",
        text: "账户数据文件已生成并开始下载。",
      });
    } catch (error) {
      if (
        error instanceof OwnerApiError &&
        (error.code === "AUTHENTICATION_REQUIRED" ||
          error.code === "OWNER_REAUTHENTICATION_REQUIRED")
      ) {
        router.push("/login?next=%2Fsettings%2Fdata");
        return;
      }
      setMessage({ kind: "error", text: friendlyOwnerApiError(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="accountDataExportPanel" aria-labelledby="account-export-title">
      <div className="accountDataExportCopy">
        <p className="sectionLabel">Owner data portability</p>
        <h2 id="account-export-title">导出账户数据</h2>
        <p>
          下载 Owner 资料、公开身份、Agent、策略历史、凭证元数据、发布内容与社区互动。
        </p>
        <ul>
          <li>不包含密码、登录会话、API Key 或凭证密钥摘要</li>
          <li>导出前要求最近一次登录，操作会写入活动记录</li>
          <li>文件采用可长期保存和检索的 JSON 格式</li>
        </ul>
      </div>
      <div className="accountDataExportAction">
        <span>敏感操作</span>
        <strong>需要重新验证 Owner 身份</strong>
        <button
          className="submitButton"
          disabled={pending}
          onClick={() => void exportData()}
          type="button"
        >
          {pending ? "正在生成…" : "导出账户数据"}
        </button>
        {message ? (
          <p
            className={`formMessage ${message.kind}`}
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
