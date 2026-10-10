/**
 * 数据浏览编辑对话框：按列元数据生成表单（insert/update 双模式）。
 * 规则：PK 在 update 只读；二进制/数组列只读；空字符串按 NULL 提交（可空列）。
 */
import { useEffect, useMemo, useState } from "react";
import type { DbBoardColumnMeta } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const READONLY_FAMILIES = new Set(["binary", "array"]);

function isColumnEditable(column: DbBoardColumnMeta, mode: "insert" | "update"): boolean {
  if (READONLY_FAMILIES.has(column.family)) return false;
  if (mode === "update" && column.isPrimaryKey) return false;
  return true;
}

function initialValueFor(column: DbBoardColumnMeta, row: Record<string, unknown> | null): string {
  const value = row?.[column.name];
  return value === null || value === undefined ? "" : String(value);
}

export function DbBoardEditDialog({
  open,
  onOpenChange,
  mode,
  columns,
  row,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "insert" | "update";
  columns: readonly DbBoardColumnMeta[];
  row: Record<string, unknown> | null;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const editableColumns = useMemo(
    () => columns.filter((column) => isColumnEditable(column, mode)),
    [columns, mode],
  );
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [boolValues, setBoolValues] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const nextText: Record<string, string> = {};
    const nextBool: Record<string, boolean> = {};
    for (const column of editableColumns) {
      if (column.family === "boolean") {
        nextBool[column.name] = row?.[column.name] === true || row?.[column.name] === "true" || row?.[column.name] === "t";
      } else {
        nextText[column.name] = initialValueFor(column, row);
      }
    }
    setTextValues(nextText);
    setBoolValues(nextBool);
  }, [open, editableColumns, row]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const values: Record<string, unknown> = {};
      for (const column of editableColumns) {
        if (column.family === "boolean") {
          values[column.name] = boolValues[column.name] ?? false;
        } else {
          const raw = (textValues[column.name] ?? "").trim();
          values[column.name] = raw === "" ? null : raw;
        }
      }
      const ok = await onSubmit(values);
      if (ok) {
        onOpenChange(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: mode === "insert" ? "dbboard.data.insertTitle" : "dbboard.data.updateTitle",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "dbboard.data.editDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {columns.map((column) => {
            const editable = isColumnEditable(column, mode);
            const required = !column.nullable && !column.hasDefault && editable;
            return (
              <div key={column.name} className="flex flex-col gap-1.5">
                <Label htmlFor={`dbboard-col-${column.name}`} className="flex items-center gap-1.5">
                  <span className="font-mono">{column.name}</span>
                  {column.isPrimaryKey ? (
                    <span className="rounded bg-surface px-1 text-ui-xs text-foreground-subtle">PK</span>
                  ) : null}
                  {required ? <span className="text-destructive">*</span> : null}
                </Label>
                {editable && column.family === "boolean" ? (
                  <Switch
                    id={`dbboard-col-${column.name}`}
                    checked={boolValues[column.name] ?? false}
                    onCheckedChange={(checked) =>
                      setBoolValues((prev) => ({ ...prev, [column.name]: checked }))
                    }
                    disabled={submitting}
                  />
                ) : (
                  <Input
                    id={`dbboard-col-${column.name}`}
                    value={
                      editable ? (textValues[column.name] ?? "") : initialValueFor(column, row)
                    }
                    onChange={(event) =>
                      setTextValues((prev) => ({ ...prev, [column.name]: event.target.value }))
                    }
                    disabled={!editable || submitting}
                    className="font-mono text-ui-base"
                    placeholder={
                      editable
                        ? intl.formatMessage({ id: "dbboard.data.valuePlaceholder" })
                        : undefined
                    }
                  />
                )}
                <span className="text-ui-xs text-foreground-subtle">{column.dataType}</span>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {intl.formatMessage({
              id: mode === "insert" ? "dbboard.data.insertSubmit" : "dbboard.data.updateSubmit",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
