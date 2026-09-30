import { spawn } from "node:child_process";

export interface NativeDirectoryPickResult {
  /** 服务端是否具备原生选择能力（Windows 且 PowerShell 可用）；false 时调用方走降级。 */
  supported: boolean;
  /** 用户选中的绝对路径；取消时为 null（仅在 supported=true 时有意义）。 */
  path: string | null;
}

/** PowerShell 单引号字面量转义。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * 在 server（Windows）桌面弹出系统自带 FolderBrowserDialog，返回用户选中的目录。
 * Web 客户端本身无法打开系统目录框；server 跑在用户本机时，由 server 代弹并把路径
 * 经 RPC 回传，选到的即 server 侧工作区真实路径。非 Windows / PowerShell 不可用 /
 * 进程异常退出时返回 supported=false，调用方降级（如服务端目录浏览器）。
 */
export function pickWindowsDirectory(description: string): Promise<NativeDirectoryPickResult> {
  if (process.platform !== "win32") {
    return Promise.resolve({ supported: false, path: null });
  }
  // STA 是 WinForms 对话框的硬要求；TopMost 宿主窗体保证对话框不被浏览器挡在后面。
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = ${psQuote(description)}`,
    "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
  ].join("; ");
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let stdout = "";
    let aborted = false;
    // 对话框允许长时间停留（用户慢慢浏览目录）；超时仅作兜底防僵尸进程。
    const timer = setTimeout(
      () => {
        aborted = true;
        child.kill();
      },
      15 * 60_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ supported: false, path: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (aborted || code !== 0) {
        resolve({ supported: false, path: null });
        return;
      }
      const path = stdout.trim();
      resolve({ supported: true, path: path.length > 0 ? path : null });
    });
  });
}
