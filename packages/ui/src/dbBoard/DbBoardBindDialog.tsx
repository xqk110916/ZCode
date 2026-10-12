/**
 * DbBoardBindDialog —— 数据库连接与工作区绑定的确认对话框。
 *
 * 连接 + 目标项目双选择器：目标项目选项 = 当前项目置顶 + 最近项目（recentProjects）
 * 按服务端同款归一化去重，默认当前项目；条件挂载（父组件 bindOpen 时才渲染）
 * 保证每次打开都取最新默认值。
 */
import { useState } from "react";
import type { DbBoardConnectionEntry } from "@zcode/services";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function connectionLabel(entry: DbBoardConnectionEntry): string {
  const label = entry.name?.trim() || `${entry.host}/${entry.database}`;
  return entry.env?.trim() ? `${label}（${entry.env.trim()}）` : label;
}

/** 绑定键 → 展示名（取路径末段，多个同名时仍可 hover 完整键）。 */
export function workspaceDisplayName(key: string): string {
  const parts = key.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? key;
}

/** blocked 空态 / 页头共用的轻量横幅（错误沿用数据 tab 同款视觉，成功用 success 色）。 */
export function DbBoardInlineNotice(props: {
  tone: "success" | "error";
  message: string;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className={cn(
        "flex max-w-lg items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-ui-sm",
        props.tone === "success"
          ? "border-success/40 bg-success-subtle text-success"
          : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      <span className="line-clamp-2 break-all">{props.message}</span>
      <Button variant="ghost" size="sm" onClick={props.onClose}>
        {intl.formatMessage({ id: "common.close" })}
      </Button>
    </div>
  );
}

export interface DbBoardWorkspaceOption {
  key: string;
  isCurrent: boolean;
}

/** 与服务端 workspaceBindingKey 同款归一化，仅用于绑定目标选项去重（写入键由服务端归一化）。 */
export function workspaceOptionKey(path: string): string {
  return path.trim().replace(/\//g, "\\").toLowerCase();
}

export function DbBoardBindDialog(props: {
  connections: DbBoardConnectionEntry[];
  defaultConnectionId: string;
  workspaceOptions: DbBoardWorkspaceOption[];
  onBind: (connectionId: string, targetWorkspaceKey: string) => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [connectionId, setConnectionId] = useState(props.defaultConnectionId);
  const [workspaceTarget, setWorkspaceTarget] = useState(props.workspaceOptions[0]?.key ?? "");

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "dbboard.binding.confirmTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "dbboard.binding.confirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbboard-bind-connection">
              {intl.formatMessage({ id: "dbboard.binding.connectionLabel" })}
            </Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger id="dbboard-bind-connection" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {props.connections.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {connectionLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {props.workspaceOptions.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbboard-bind-workspace">
                {intl.formatMessage({ id: "dbboard.binding.workspaceLabel" })}
              </Label>
              <Select value={workspaceTarget} onValueChange={setWorkspaceTarget}>
                <SelectTrigger id="dbboard-bind-workspace" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.workspaceOptions.map((option) => (
                    <SelectItem key={option.key} value={option.key} className="whitespace-normal">
                      {option.isCurrent
                        ? intl.formatMessage(
                            { id: "dbboard.binding.currentWorkspaceOption" },
                            { workspace: option.key },
                          )
                        : option.key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
          <AlertDialogAction onClick={() => props.onBind(connectionId, workspaceTarget)}>
            {intl.formatMessage({ id: "dbboard.binding.bindAction" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
