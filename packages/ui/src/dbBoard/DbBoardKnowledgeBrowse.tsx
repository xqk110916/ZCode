/**
 * 知识浏览区：搜索 + 业务域分组的表卡片列表；支持卡片编辑/新增/删除与 Markdown 导出。
 */
import { useMemo, useState } from "react";
import { Download, Pencil, Plus, Search as SearchIcon, Trash2 } from "lucide-react";
import type {
  DbBoardColumnMeta,
  DbBoardKnowledge,
  DbBoardKnowledgeTableCard,
  DbBoardTableMeta,
  DbBoardUsageSummary,
} from "@zcode/services";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildKnowledgeMarkdown, knowledgeExportFileName } from "@/dbBoard/dbBoardKnowledgeDoc.js";
import { DbBoardKnowledgeCardDialog } from "@/dbBoard/DbBoardKnowledgeCardDialog.js";

function TableCardView({
  card,
  onEdit,
  onDelete,
}: {
  card: DbBoardKnowledgeTableCard;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-surface p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-ui-sm font-medium text-foreground">
          {card.table}
        </span>
        <Badge variant="outline">{card.domain}</Badge>
        {card.source === "extracted" ? (
          <Badge variant="secondary">
            {intl.formatMessage({ id: "dbboard.knowledge.sourceExtracted" })}
          </Badge>
        ) : card.source === "db-comment" ? (
          <Badge variant="secondary">
            {intl.formatMessage({ id: "dbboard.knowledge.sourceDbComment" })}
          </Badge>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-6" onClick={onEdit}>
            <Pencil />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6">
                <Trash2 />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {intl.formatMessage({ id: "dbboard.knowledge.cardDeleteTitle" })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {intl.formatMessage(
                    { id: "dbboard.knowledge.cardDeleteDescription" },
                    { table: card.table },
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>
                  {intl.formatMessage({ id: "common.delete" })}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </span>
      </div>
      <p className="text-ui-sm text-foreground">{card.purpose}</p>
      {card.keyColumns.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {card.keyColumns.slice(0, 6).map((column) => (
            <span
              key={column.name}
              className="rounded bg-background px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
              title={`${column.name}=${column.meaning}`}
            >
              {column.name}
            </span>
          ))}
          {card.keyColumns.length > 6 ? (
            <span className="rounded bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "dbboard.knowledge.moreColumns" },
                { count: card.keyColumns.length - 6 },
              )}
            </span>
          ) : null}
        </div>
      ) : null}
      {card.relations.length > 0 ? (
        <div className="text-ui-xs text-foreground-subtle">
          <span className="font-medium">
            {intl.formatMessage({ id: "dbboard.knowledge.relations" })}:
          </span>{" "}
          {card.relations
            .slice(0, 4)
            .map((relation) => `${relation.target}${relation.on ? ` (${relation.on})` : ""}`)
            .join("; ")}
        </div>
      ) : null}
      {card.notes ? <div className="text-ui-xs text-foreground-subtle">{card.notes}</div> : null}
    </div>
  );
}

export function DbBoardKnowledgeBrowse({
  knowledge,
  keyword,
  onKeywordChange,
  projectRoot,
  onSaveCard,
  onDeleteCard,
  tables,
  onLoadColumns,
  onDistill,
  onEnsureSummary,
}: {
  knowledge: DbBoardKnowledge;
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  projectRoot: string;
  onSaveCard: (card: DbBoardKnowledgeTableCard) => Promise<boolean>;
  onDeleteCard: (table: string) => Promise<boolean>;
  /** 表清单（新增卡片下拉数据源）。 */
  tables: readonly DbBoardTableMeta[];
  onLoadColumns: (schema: string, table: string) => Promise<DbBoardColumnMeta[]>;
  onDistill: (schema: string, table: string) => Promise<DbBoardKnowledgeTableCard>;
  /** 导出时确保汇总已生成（缓存缺失则补算），并把概览写进文档。 */
  onEnsureSummary: () => Promise<DbBoardUsageSummary | null>;
}) {
  const { intl } = useZCodeIntl();
  const [editingCard, setEditingCard] = useState<DbBoardKnowledgeTableCard | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const domainOptions = useMemo(
    () => Object.keys(knowledge.domains).sort((a, b) => a.localeCompare(b)),
    [knowledge.domains],
  );

  const domainEntries = useMemo(() => {
    const search = keyword.trim().toLowerCase();
    const entries = Object.entries(knowledge.domains)
      .map(([domain, tables]) => ({
        domain,
        cards: tables
          .map((table) => knowledge.tables[table])
          .filter((card): card is DbBoardKnowledgeTableCard => Boolean(card))
          .filter(
            (card) =>
              !search ||
              card.table.includes(search) ||
              card.purpose.toLowerCase().includes(search) ||
              domain.toLowerCase().includes(search),
          ),
      }))
      .filter((entry) => entry.cards.length > 0);
    entries.sort((a, b) => b.cards.length - a.cards.length);
    return entries;
  }, [knowledge, keyword]);

  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    try {
      // 汇总缓存缺失时先补算（compute=true 有缓存直接复用），导出文档带概览章节。
      const summary = await onEnsureSummary();
      const markdown = buildKnowledgeMarkdown(knowledge, summary);
    const blob = new Blob(["\uFEFF".concat(markdown)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = knowledgeExportFileName();
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const openNew = () => {
    setEditingCard(null);
    setDialogOpen(true);
  };

  const openEdit = (card: DbBoardKnowledgeTableCard) => {
    setEditingCard(card);
    setDialogOpen(true);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-card p-4">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "dbboard.knowledge.browseTitle" })}
        </span>
        <Button variant="ghost" size="sm" onClick={openNew}>
          <Plus />
          {intl.formatMessage({ id: "dbboard.knowledge.cardNew" })}
        </Button>
        <Button variant="ghost" size="sm" disabled={exporting} onClick={() => void handleExport()}>
          {exporting ? <Spinner className="size-4" /> : <Download />}
          {intl.formatMessage({ id: "dbboard.knowledge.export" })}
        </Button>
        <div className="relative ml-auto w-64">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle" />
          <Input
            size="sm"
            value={keyword}
            onChange={(event) => onKeywordChange(event.target.value)}
            placeholder={intl.formatMessage({ id: "dbboard.knowledge.searchPlaceholder" })}
            className="pl-7 text-ui-base"
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {domainEntries.length === 0 ? (
          <p className="py-4 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "dbboard.knowledge.noMatch" })}
          </p>
        ) : (
          domainEntries.map((entry) => (
            <div key={entry.domain} className="flex flex-col gap-1.5">
              <span className="text-ui-xs font-medium text-foreground-subtle">
                {entry.domain}（{entry.cards.length}）
              </span>
              <div className="grid gap-2 xl:grid-cols-2">
                {entry.cards.map((card) => (
                  <TableCardView
                    key={card.table}
                    card={card}
                    onEdit={() => openEdit(card)}
                    onDelete={() => void onDeleteCard(card.table)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <p className="shrink-0 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.knowledge.openInZCodeHint" })}
        <span className="font-mono">{projectRoot}</span>
      </p>
      <DbBoardKnowledgeCardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editingCard}
        domainOptions={domainOptions}
        tables={tables}
        knowledge={knowledge}
        onLoadColumns={onLoadColumns}
        onDistill={onDistill}
        onSave={onSaveCard}
      />
    </section>
  );
}
