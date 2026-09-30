import { useCallback, useEffect, useState } from "react";
import { Check, FolderPlus, History, Loader2, MonitorSmartphone, Server, X } from "lucide-react";
import type { ZCodeGuideEntry } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";

type GuideModuleKey = "frontend" | "backend";

interface GuideSectionProps {
  /** 提交/重新添加后批量加入工作区项目并跳转（specs/ui/settings-guide-new.md）。 */
  onAddWorkspaceProjects?: (paths: string[]) => void;
}

/**
 * 设置「引导(新)」分区：为前端/后端代码各选择一个或多个项目文件夹，
 * 连同名称/备注保存为引导记录后批量加入工作区「项目」分区。
 * 交互与样式复刻首启引导页（OccupationOnboarding）的卡片 token。
 */
export function GuideSection({ onAddWorkspaceProjects }: GuideSectionProps) {
  const { intl, localePreference } = useZCodeIntl();
  const services = useServices();
  const platform = useOptionalPlatform();
  const [name, setName] = useState("");
  const [remark, setRemark] = useState("");
  const [frontendPaths, setFrontendPaths] = useState<string[]>([]);
  const [backendPaths, setBackendPaths] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ZCodeGuideEntry[]>([]);
  const [entriesLoaded, setEntriesLoaded] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const guideEntryService = services.guideEntryService;
  const t = useCallback(
    (key: string) => intl.formatMessage({ id: `settings.guideNew.${key}` }),
    [intl],
  );

  const refreshEntries = useCallback(async () => {
    if (!guideEntryService) {
      setEntriesLoaded(true);
      return;
    }
    try {
      setEntries(await guideEntryService.list());
    } catch (cause) {
      logger.warn("[settings-guide-new] 读取引导记录失败", { error: String(cause) });
    } finally {
      setEntriesLoaded(true);
    }
  }, [guideEntryService]);

  useEffect(() => {
    void refreshEntries();
  }, [refreshEntries]);

  const canSelectDirectory = Boolean(platform);
  const canSubmit =
    !submitting &&
    Boolean(guideEntryService) &&
    name.trim().length > 0 &&
    frontendPaths.length > 0 &&
    backendPaths.length > 0;

  const handleAddFolder = useCallback(async (moduleKey: GuideModuleKey) => {
    const selected = await platform?.selectDirectory();
    // 取消目录选择框：表单保持不变。
    if (!selected) {
      return;
    }
    if (moduleKey === "frontend") {
      setFrontendPaths((prev) => (prev.includes(selected) ? prev : [...prev, selected]));
    } else {
      setBackendPaths((prev) => (prev.includes(selected) ? prev : [...prev, selected]));
    }
  }, [platform]);

  const handleRemovePath = useCallback((moduleKey: GuideModuleKey, path: string) => {
    if (moduleKey === "frontend") {
      setFrontendPaths((prev) => prev.filter((entry) => entry !== path));
    } else {
      setBackendPaths((prev) => prev.filter((entry) => entry !== path));
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !guideEntryService) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await guideEntryService.create({ name, remark, frontendPaths, backendPaths });
      // 添加并跳转：前端在前、后端在后，激活第一个项目。
      onAddWorkspaceProjects?.([...frontendPaths, ...backendPaths]);
      setName("");
      setRemark("");
      setFrontendPaths([]);
      setBackendPaths([]);
      await refreshEntries();
    } catch (cause) {
      logger.error("[settings-guide-new] 保存引导记录失败", { error: String(cause) });
      setError(t("submitError"));
    } finally {
      setSubmitting(false);
    }
  }, [
    backendPaths,
    canSubmit,
    frontendPaths,
    guideEntryService,
    name,
    onAddWorkspaceProjects,
    refreshEntries,
    remark,
    t,
  ]);

  const handleReAdd = useCallback(
    (entry: ZCodeGuideEntry) => {
      onAddWorkspaceProjects?.([...entry.frontendPaths, ...entry.backendPaths]);
    },
    [onAddWorkspaceProjects],
  );

  const handleDelete = useCallback(
    async (entry: ZCodeGuideEntry) => {
      try {
        await guideEntryService?.delete({ entryId: entry.id });
        setPendingDeleteId(null);
        await refreshEntries();
      } catch (cause) {
        logger.error("[settings-guide-new] 删除引导记录失败", { error: String(cause) });
      }
    },
    [guideEntryService, refreshEntries],
  );

  return (
    <div className="flex flex-col gap-6" data-testid="settings-guide-new-section">
      <p className="text-ui-base leading-relaxed text-foreground-subtle">{t("description")}</p>

      <section className="flex flex-col gap-5 rounded-xl border border-card-border bg-card p-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="guide-new-name" className="text-ui-base font-medium">
            {t("nameLabel")} <span className="text-destructive">*</span>
          </Label>
          <Input
            id="guide-new-name"
            value={name}
            placeholder={t("namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-lg text-ui-base"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="guide-new-remark" className="text-ui-base font-medium">
            {t("remarkLabel")}
          </Label>
          <SettingsFormTextarea
            id="guide-new-remark"
            value={remark}
            rows={2}
            placeholder={t("remarkPlaceholder")}
            onChange={(event) => setRemark(event.target.value)}
            className="min-h-0 resize-none"
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <GuideModuleCard
            icon={<MonitorSmartphone className="size-4 shrink-0" aria-hidden />}
            label={t("frontendLabel")}
            description={t("frontendDescription")}
            paths={frontendPaths}
            addDisabled={!canSelectDirectory || submitting}
            onAdd={() => void handleAddFolder("frontend")}
            onRemove={(path) => handleRemovePath("frontend", path)}
            emptyHint={t("frontendEmptyHint")}
            addLabel={t("addFolder")}
            removeLabel={t("removeFolder")}
            requiredLabel={t("required")}
          />
          <GuideModuleCard
            icon={<Server className="size-4 shrink-0" aria-hidden />}
            label={t("backendLabel")}
            description={t("backendDescription")}
            paths={backendPaths}
            addDisabled={!canSelectDirectory || submitting}
            onAdd={() => void handleAddFolder("backend")}
            onRemove={(path) => handleRemovePath("backend", path)}
            emptyHint={t("backendEmptyHint")}
            addLabel={t("addFolder")}
            removeLabel={t("removeFolder")}
            requiredLabel={t("required")}
          />
        </div>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-ui-sm text-foreground-subtle">{t("submitHint")}</p>
          <Button
            disabled={!canSubmit}
            className="h-11 shrink-0 rounded-xl px-5 text-ui-base"
            onClick={() => void handleSubmit()}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("submitting")}
              </>
            ) : (
              t("submit")
            )}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-ui-base font-semibold">
          <History className="size-4 shrink-0 text-foreground-subtle" aria-hidden />
          {t("historyTitle")}
        </h2>
        {!entriesLoaded ? (
          <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("historyLoading")}
          </div>
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-card-border bg-card p-5 text-ui-sm text-foreground-subtle">
            {t("historyEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-5 transition-colors hover:bg-surface-hover/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ui-base font-medium">{entry.name}</span>
                  <Badge variant="secondary" className="text-ui-xs">
                    {new Date(entry.createdAt).toLocaleString(
                      localePreference === "en-US" ? "en-US" : "zh-CN",
                    )}
                  </Badge>
                </div>
                {entry.remark ? (
                  <p className="text-ui-sm text-foreground-subtle">{entry.remark}</p>
                ) : null}
                <div className="flex flex-col gap-1 text-ui-sm">
                  <GuideEntryPathGroup
                    label={t("frontendLabel")}
                    paths={entry.frontendPaths}
                  />
                  <GuideEntryPathGroup label={t("backendLabel")} paths={entry.backendPaths} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="h-8 rounded-lg px-3 text-ui-sm"
                    onClick={() => handleReAdd(entry)}
                  >
                    <FolderPlus className="size-4" aria-hidden />
                    {t("reAdd")}
                  </Button>
                  {pendingDeleteId === entry.id ? (
                    <>
                      <span className="text-ui-sm text-foreground-subtle">{t("deleteConfirm")}</span>
                      <Button
                        variant="destructive"
                        className="h-8 rounded-lg px-3 text-ui-sm"
                        onClick={() => void handleDelete(entry)}
                      >
                        <Check className="size-4" aria-hidden />
                        {t("deleteConfirmYes")}
                      </Button>
                      <Button
                        variant="link"
                        className="h-8 rounded-lg px-3 text-ui-sm text-foreground-subtle"
                        onClick={() => setPendingDeleteId(null)}
                      >
                        {t("deleteConfirmNo")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="link"
                      className="h-8 rounded-lg px-3 text-ui-sm text-foreground-subtle"
                      onClick={() => setPendingDeleteId(entry.id)}
                    >
                      <X className="size-4" aria-hidden />
                      {t("delete")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function GuideModuleCard({
  icon,
  label,
  description,
  paths,
  addDisabled,
  onAdd,
  onRemove,
  emptyHint,
  addLabel,
  removeLabel,
  requiredLabel,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  paths: string[];
  addDisabled: boolean;
  onAdd: () => void;
  onRemove: (path: string) => void;
  emptyHint: string;
  addLabel: string;
  removeLabel: string;
  requiredLabel: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-5 transition-colors hover:bg-surface-hover/50">
      <div className="flex items-center gap-2">
        <span className="text-foreground-subtle">{icon}</span>
        <span className="text-ui-base font-medium">{label}</span>
        <span className="text-ui-sm text-destructive">{requiredLabel}</span>
        <Badge variant="secondary" className="ml-auto text-ui-xs">
          {paths.length}
        </Badge>
      </div>
      <p className="text-ui-sm text-foreground-subtle">{description}</p>
      {paths.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-xl border border-border bg-background p-1">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-2 rounded-lg p-3 transition-colors hover:bg-surface-hover/50"
            >
              <span title={path} className="min-w-0 flex-1 truncate text-ui-sm" aria-label={path}>
                {path}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 rounded-md"
                aria-label={removeLabel}
                onClick={() => onRemove(path)}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg p-3 text-ui-sm text-foreground-subtle">{emptyHint}</p>
      )}
      <Button
        variant="outline"
        disabled={addDisabled}
        className="h-9 w-full rounded-lg border-dashed text-ui-sm"
        onClick={onAdd}
      >
        <FolderPlus className="size-4" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

function GuideEntryPathGroup({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) {
    return null;
  }
  return (
    <p className="text-ui-sm text-foreground-subtle" title={paths.join("\n")}>
      {label}：{paths.join("、")}
    </p>
  );
}
