/* eslint-disable max-lines -- 表单（名称/备注/双模块文件夹卡）与历史记录列表集中在引导(新)内容件里，
   与 GuideModuleCard 共享模块卡上下文；拆分收益低，先保持单一内容件收口。 */
import { useCallback, useEffect, useState } from "react";
import { Check, FolderPlus, History, Loader2, MonitorSmartphone, Server, X } from "lucide-react";
import type { ZCodeGuideEntry } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type GuideModuleKey = "frontend" | "backend";

/**
 * 设置「引导(新)」的引导页内容（specs/ui/settings-guide-new.md）。
 * 复用 OccupationOnboarding 的左栏容器（标题/滚动/页脚按钮节奏），本组件只负责
 * 表单与历史记录内容：前端/后端各选一个或多个文件夹 + 名称(必填)/备注(选填)，
 * 提交后经 onAddWorkspaceProjects 批量加入工作区「项目」并跳转，随后关闭引导层。
 * 文件夹选择与「打开工作区」同口径：桌面端走系统目录框；Web/远程端
 * （preferDirectoryBrowser）或系统对话框异常时退回服务端目录浏览器 DirectoryBrowser。
 */
export function GuideNewPanel({
  onAddWorkspaceProjects,
  onClose,
  preferDirectoryBrowser = false,
}: {
  onAddWorkspaceProjects?: (paths: string[]) => void;
  onClose: () => void;
  preferDirectoryBrowser?: boolean;
}) {
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
  // 服务端目录浏览器当前服务的模块（null = 关闭）。
  const [directoryBrowserTarget, setDirectoryBrowserTarget] = useState<GuideModuleKey | null>(
    null,
  );

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
      logger.warn("[guide-new] 读取引导记录失败", { error: String(cause) });
    } finally {
      setEntriesLoaded(true);
    }
  }, [guideEntryService]);

  useEffect(() => {
    void refreshEntries();
  }, [refreshEntries]);

  const canSubmit =
    !submitting &&
    Boolean(guideEntryService) &&
    name.trim().length > 0 &&
    frontendPaths.length > 0 &&
    backendPaths.length > 0;

  const appendPath = useCallback((moduleKey: GuideModuleKey, path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      return;
    }
    if (moduleKey === "frontend") {
      setFrontendPaths((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    } else {
      setBackendPaths((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    }
  }, []);

  const handleAddFolder = useCallback(
    async (moduleKey: GuideModuleKey) => {
      // Web/server 根节点没有系统目录选择框（与 openWorkspaceFolderEntry 同口径）：
      // preferDirectoryBrowser 时直接打开服务端目录浏览器，确保选到目标 host 上的路径。
      if (preferDirectoryBrowser) {
        setDirectoryBrowserTarget(moduleKey);
        return;
      }
      try {
        const selected = await platform?.selectDirectory();
        // 取消目录选择框：表单保持不变。
        if (selected) {
          appendPath(moduleKey, selected);
        }
      } catch (cause) {
        // 系统对话框在部分嵌入环境（受限 preload）会抛 IPC 异常；退回目录浏览器而不是留下未处理 Promise。
        logger.error("[guide-new] 系统目录选择框调用失败，退回服务端目录浏览器", {
          error: String(cause),
        });
        setDirectoryBrowserTarget(moduleKey);
      }
    },
    [appendPath, platform, preferDirectoryBrowser],
  );

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
      // 添加并跳转：前端在前、后端在后，激活第一个项目；随后关闭引导层让出主界面。
      onAddWorkspaceProjects?.([...frontendPaths, ...backendPaths]);
      onClose();
    } catch (cause) {
      logger.error("[guide-new] 保存引导记录失败", { error: String(cause) });
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
    onClose,
    remark,
    t,
  ]);

  const handleReAdd = useCallback(
    (entry: ZCodeGuideEntry) => {
      onAddWorkspaceProjects?.([...entry.frontendPaths, ...entry.backendPaths]);
      onClose();
    },
    [onAddWorkspaceProjects, onClose],
  );

  const handleDelete = useCallback(
    async (entry: ZCodeGuideEntry) => {
      try {
        await guideEntryService?.delete({ entryId: entry.id });
        setPendingDeleteId(null);
        await refreshEntries();
      } catch (cause) {
        logger.error("[guide-new] 删除引导记录失败", { error: String(cause) });
      }
    },
    [guideEntryService, refreshEntries],
  );

  return (
    <>
    <section className="flex w-full flex-col">
      <div className="w-full">
        <h1 className="text-ui-xl font-semibold tracking-tight text-center">{t("title")}</h1>
        <p className="mx-auto mt-3 max-w-md text-center text-ui-base leading-relaxed text-foreground-subtle">
          {t("description")}
        </p>

        <div className="mt-8 space-y-3">
          <div className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card p-5 transition-colors hover:bg-surface-hover dark:bg-surface/40">
            <Label htmlFor="guide-new-name" className="text-ui-base font-medium">
              {t("nameLabel")}
            </Label>
            <Input
              id="guide-new-name"
              value={name}
              placeholder={t("namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              className="col-start-2 h-9 rounded-lg text-ui-base"
            />
            <Label htmlFor="guide-new-remark" className="text-ui-base font-medium">
              {t("remarkLabel")}
            </Label>
            <Textarea
              id="guide-new-remark"
              value={remark}
              rows={2}
              placeholder={t("remarkPlaceholder")}
              onChange={(event) => setRemark(event.target.value)}
              className="col-start-2 min-h-0 resize-none rounded-lg border border-input-border bg-input px-2 py-2 text-ui-base shadow-none placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0"
            />
          </div>
          <GuideModuleCard
            icon={<MonitorSmartphone className="size-4 shrink-0" aria-hidden />}
            label={t("frontendLabel")}
            description={t("frontendDescription")}
            paths={frontendPaths}
            addDisabled={submitting || (!platform && !preferDirectoryBrowser)}
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
            addDisabled={submitting || (!platform && !preferDirectoryBrowser)}
            onAdd={() => void handleAddFolder("backend")}
            onRemove={(path) => handleRemovePath("backend", path)}
            emptyHint={t("backendEmptyHint")}
            addLabel={t("addFolder")}
            removeLabel={t("removeFolder")}
            requiredLabel={t("required")}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-4 text-ui-sm text-destructive">
            {t("submitError")}
          </p>
        ) : null}
      </div>

      <footer className="mt-6 flex flex-col gap-3 [@media(max-height:740px)]:mt-4 [@media(max-height:740px)]:gap-1">
        <Button
          variant="link"
          disabled={submitting}
          className="order-2 h-9 self-center rounded-xl px-3 text-ui-base text-foreground-subtle"
          onClick={onClose}
        >
          {t("cancel")}
        </Button>
        <div className="flex w-full gap-3">
          <Button
            disabled={!canSubmit}
            className="h-11 flex-1 rounded-xl px-5 text-ui-base"
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
      </footer>

      <section className="mt-8 flex flex-col gap-3 border-t border-border pt-6">
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
          <p className="rounded-xl border border-card-border bg-card p-4 text-ui-sm text-foreground-subtle">
            {t("historyEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-2 rounded-xl border border-card-border bg-card p-4 transition-colors hover:bg-surface-hover/50"
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
                  {entry.frontendPaths.length > 0 ? (
                    <p className="text-foreground-subtle" title={entry.frontendPaths.join("\n")}>
                      {t("frontendLabel")}：{entry.frontendPaths.join("、")}
                    </p>
                  ) : null}
                  {entry.backendPaths.length > 0 ? (
                    <p className="text-foreground-subtle" title={entry.backendPaths.join("\n")}>
                      {t("backendLabel")}：{entry.backendPaths.join("、")}
                    </p>
                  ) : null}
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
                      <span className="text-ui-sm text-foreground-subtle">
                        {t("deleteConfirm")}
                      </span>
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
    </section>
    {directoryBrowserTarget ? (
      <DirectoryBrowser
        services={services}
        onSelect={(path) => {
          appendPath(directoryBrowserTarget, path);
          setDirectoryBrowserTarget(null);
        }}
        onCancel={() => setDirectoryBrowserTarget(null)}
      />
    ) : null}
    </>
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
    // 卡片容器沿用引导页选项卡 token：rounded-xl border p-5 + hover:bg-surface-hover。
    <div className="rounded-xl border border-card-border bg-card p-5 transition-colors hover:bg-surface-hover dark:bg-surface/40">
      <div className="flex items-center gap-2">
        <span className="text-foreground-subtle">{icon}</span>
        <span className="text-ui-base font-medium">{label}</span>
        <span className="text-ui-sm text-destructive">{requiredLabel}</span>
        <Badge variant="secondary" className="ml-auto text-ui-xs">
          {paths.length}
        </Badge>
      </div>
      <p className="mt-1 text-ui-sm font-normal text-foreground-subtle">{description}</p>
      {paths.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1">
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
        <p className="mt-3 rounded-lg p-3 text-ui-sm text-foreground-subtle">{emptyHint}</p>
      )}
      <Button
        variant="outline"
        disabled={addDisabled}
        className="mt-3 h-9 w-full rounded-lg border-dashed text-ui-sm"
        onClick={onAdd}
      >
        <FolderPlus className="size-4" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}
