/**
 * 知识卡编辑/新增对话框：
 * - 新增模式：表名为可筛选下拉（已有卡/无卡区分），选中后自动带出（已有卡内容或列注释）
 * - AI 蒸馏：单表手动触发蒸馏（服务端汇集 DB 注释 + 既有卡证据），结果填充表单供确认
 * - 关键字段每行 `列名=含义`；表关联每行 `表|ON 条件|类型`
 * 手动卡片保存标记 source；构建重建时按证据覆盖（对话框有提示）。
 */
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type {
  DbBoardColumnMeta,
  DbBoardKnowledge,
  DbBoardKnowledgeTableCard,
  DbBoardTableMeta,
} from "@zcode/services";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardTablePicker } from "@/dbBoard/DbBoardTablePicker.js";

const SOURCE_OPTIONS: Array<DbBoardKnowledgeTableCard["source"]> = [
  "distilled",
  "extracted",
  "db-comment",
];

function keyColumnsToText(card: DbBoardKnowledgeTableCard | null): string {
  return (card?.keyColumns ?? []).map((column) => `${column.name}=${column.meaning}`).join("\n");
}

function relationsToText(card: DbBoardKnowledgeTableCard | null): string {
  return (card?.relations ?? [])
    .map((relation) => [relation.target, relation.on ?? "", relation.kind ?? ""].join("|"))
    .join("\n");
}

function parseKeyValueLines(text: string): Array<{ name: string; meaning: string }> {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return { name: line, meaning: "" };
      }
      return { name: line.slice(0, separator).trim(), meaning: line.slice(separator + 1).trim() };
    })
    .filter((entry) => entry.name);
}

function parseRelationLines(text: string): DbBoardKnowledgeTableCard["relations"] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [target = "", on = "", kind = ""] = line.split("|").map((part) => part.trim());
      return { target, ...(on ? { on } : {}), ...(kind ? { kind } : {}) };
    })
    .filter((relation) => relation.target);
}

/** 选表后自动带出：已有卡带整卡；无卡用表注释 + 有注释的列（列名=注释）预填。 */
function buildPrefill(
  table: DbBoardTableMeta,
  columns: readonly DbBoardColumnMeta[],
  existingCard: DbBoardKnowledgeTableCard | undefined,
): {
  domain: string;
  purpose: string;
  keyColumnsText: string;
  relationsText: string;
  notes: string;
} {
  if (existingCard) {
    return {
      domain: existingCard.domain,
      purpose: existingCard.purpose,
      keyColumnsText: keyColumnsToText(existingCard),
      relationsText: relationsToText(existingCard),
      notes: existingCard.notes ?? "",
    };
  }
  const comment = table.comment?.trim() ?? "";
  return {
    domain: comment.split(/[--／/]/u)[0]?.trim() || table.name.toLowerCase().split("_")[0] || "未分类",
    purpose: comment,
    keyColumnsText: columns
      .filter((column) => column.comment)
      .slice(0, 30)
      .map((column) => `${column.name}=${column.comment}`)
      .join("\n"),
    relationsText: "",
    notes: "",
  };
}

export function DbBoardKnowledgeCardDialog({
  open,
  onOpenChange,
  editing,
  domainOptions,
  tables,
  knowledge,
  onLoadColumns,
  onDistill,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑的卡片；null = 新增。 */
  editing: DbBoardKnowledgeTableCard | null;
  domainOptions: readonly string[];
  /** 表清单（新增模式下拉数据源）。 */
  tables: readonly DbBoardTableMeta[];
  knowledge: DbBoardKnowledge | null;
  /** 拉取表列元数据（选表自动带出用）。 */
  onLoadColumns: (schema: string, table: string) => Promise<DbBoardColumnMeta[]>;
  /** 手动单表蒸馏（不落盘，返回草稿）。 */
  onDistill: (schema: string, table: string) => Promise<DbBoardKnowledgeTableCard>;
  onSave: (card: DbBoardKnowledgeTableCard) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [table, setTable] = useState("");
  const [schema, setSchema] = useState("");
  const [domain, setDomain] = useState("");
  const [purpose, setPurpose] = useState("");
  const [keyColumnsText, setKeyColumnsText] = useState("");
  const [relationsText, setRelationsText] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState<DbBoardKnowledgeTableCard["source"]>("extracted");
  const [saving, setSaving] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);

  const applyCardToForm = (card: DbBoardKnowledgeTableCard) => {
    setDomain(card.domain);
    setPurpose(card.purpose);
    setKeyColumnsText(keyColumnsToText(card));
    setRelationsText(relationsToText(card));
    setNotes(card.notes ?? "");
    setSource(card.source);
  };

  useEffect(() => {
    if (open) {
      setTable(editing?.table ?? "");
      setSchema(editing?.table ?? "");
      setDomain(editing?.domain ?? domainOptions[0] ?? "未分类");
      setPurpose(editing?.purpose ?? "");
      setKeyColumnsText(keyColumnsToText(editing));
      setRelationsText(relationsToText(editing));
      setNotes(editing?.notes ?? "");
      setSource(editing?.source ?? "extracted");
      setDistillError(null);
    }
  }, [open, editing, domainOptions]);

  /** 新增模式选表：记录 schema 并自动带出（已有卡或列注释预填）。 */
  const handleTableSelected = async (meta: DbBoardTableMeta) => {
    setTable(meta.name.toLowerCase());
    setSchema(meta.schema);
    setDistillError(null);
    const existing = knowledge?.tables[meta.name.toLowerCase()];
    if (existing) {
      applyCardToForm(existing);
      return;
    }
    setLoadingColumns(true);
    try {
      const columns = await onLoadColumns(meta.schema, meta.name);
      const prefill = buildPrefill(meta, columns, undefined);
      setDomain(prefill.domain);
      setPurpose(prefill.purpose);
      setKeyColumnsText(prefill.keyColumnsText);
      setRelationsText("");
      setNotes("");
    } catch {
      const prefill = buildPrefill(meta, [], undefined);
      setDomain(prefill.domain);
      setPurpose(prefill.purpose);
    } finally {
      setLoadingColumns(false);
    }
  };

  /** AI 蒸馏：单表手动触发，草稿回填表单（表名保持当前选择）。 */
  const handleDistill = async () => {
    if (!table.trim()) {
      return;
    }
    setDistilling(true);
    setDistillError(null);
    try {
      const draft = await onDistill(schema || "PUBLIC", table.trim());
      applyCardToForm(draft);
    } catch (error) {
      setDistillError(error instanceof Error ? error.message : String(error));
    } finally {
      setDistilling(false);
    }
  };

  const handleSave = async () => {
    if (!table.trim() || !purpose.trim()) {
      return;
    }
    setSaving(true);
    try {
      const card: DbBoardKnowledgeTableCard = {
        table: table.trim().toLowerCase(),
        domain: domain.trim() || "未分类",
        purpose: purpose.trim(),
        keyColumns: parseKeyValueLines(keyColumnsText),
        relations: parseRelationLines(relationsText),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        evidenceFiles: editing?.evidenceFiles ?? [],
        source,
      };
      const ok = await onSave(card);
      if (ok) {
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: editing ? "dbboard.knowledge.cardEditTitle" : "dbboard.knowledge.cardNewTitle",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "dbboard.knowledge.cardEditDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbk-card-table">
                {intl.formatMessage({ id: "dbboard.knowledge.cardTable" })}
              </Label>
              {editing ? (
                <Input
                  id="dbk-card-table"
                  size="sm"
                  value={table}
                  disabled
                  className="font-mono text-ui-base"
                />
              ) : (
                <DbBoardTablePicker
                  tables={tables}
                  knowledge={knowledge}
                  value={table}
                  onChange={(meta) => void handleTableSelected(meta)}
                />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbk-card-domain">
                {intl.formatMessage({ id: "dbboard.knowledge.cardDomain" })}
              </Label>
              <Input
                id="dbk-card-domain"
                size="sm"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                className="text-ui-base"
                placeholder={intl.formatMessage({ id: "dbboard.knowledge.cardDomainPlaceholder" })}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbk-card-purpose">
              {intl.formatMessage({ id: "dbboard.knowledge.cardPurpose" })}
            </Label>
            <Input
              id="dbk-card-purpose"
              size="sm"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              className="text-ui-base"
              placeholder={intl.formatMessage({ id: "dbboard.knowledge.cardPurposePlaceholder" })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbk-card-columns">
              {intl.formatMessage({ id: "dbboard.knowledge.cardColumns" })}
              {loadingColumns ? <Spinner className="ml-1.5 inline size-3" /> : null}
            </Label>
            <Textarea
              id="dbk-card-columns"
              value={keyColumnsText}
              onChange={(event) => setKeyColumnsText(event.target.value)}
              rows={5}
              className="font-mono text-ui-sm"
              placeholder={"written_time=成文时间\ndoc_status=公文状态"}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbk-card-relations">
              {intl.formatMessage({ id: "dbboard.knowledge.cardRelations" })}
            </Label>
            <Textarea
              id="dbk-card-relations"
              value={relationsText}
              onChange={(event) => setRelationsText(event.target.value)}
              rows={3}
              className="font-mono text-ui-sm"
              placeholder={"xt_user|apply_user_id = USER_ID|left-join"}
            />
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbk-card-notes">
                {intl.formatMessage({ id: "dbboard.knowledge.cardNotes" })}
              </Label>
              <Input
                id="dbk-card-notes"
                size="sm"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="text-ui-base"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "dbboard.knowledge.cardSource" })}</Label>
              <Select
                value={source}
                onValueChange={(value) => setSource(value as DbBoardKnowledgeTableCard["source"])}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {intl.formatMessage({ id: `dbboard.knowledge.source.${option}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {distillError ? (
            <p className="break-all rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
              {distillError}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => void handleDistill()}
            disabled={distilling || !table.trim()}
            title={intl.formatMessage({ id: "dbboard.knowledge.distillHint" })}
          >
            {distilling ? <Spinner className="size-3.5" /> : <Sparkles />}
            {intl.formatMessage({
              id: distilling ? "dbboard.knowledge.distilling" : "dbboard.knowledge.distill",
            })}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !table.trim() || !purpose.trim()}>
              {intl.formatMessage({ id: "dbboard.knowledge.cardSave" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
