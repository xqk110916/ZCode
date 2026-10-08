/**
 * Paperclip 自动认领（从 PaperclipPage 拆出，控制文件行数）。
 * 开关开启时对"新出现"的待 ZCode 执行任务自动认领并交外层后台执行；
 * 防重两级：内存 Set + sessionStorage（面板重开不重复认领）。
 */
import { useEffect, useMemo, useRef } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PaperclipAgent, PaperclipIssue, PaperclipProject } from "@zcode/shared";

const AUTO_CLAIMED_STORAGE_KEY = "paperclip-auto-claimed";

const SETTLED_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

export function usePaperclipAutoClaim(input: {
  enabled: boolean;
  issues: readonly PaperclipIssue[];
  zcodeAgent: PaperclipAgent | null;
  projects: readonly PaperclipProject[];
  executeInZCode: (
    issue: PaperclipIssue,
    onClaimed: (issue: PaperclipIssue) => void,
  ) => Promise<boolean>;
  onAutoExecute: (issue: PaperclipIssue, targetWorkspacePath: string | null) => void;
}): { pendingCount: number } {
  const { enabled, issues, zcodeAgent, projects, executeInZCode, onAutoExecute } = input;
  const { intl } = useZCodeIntl();
  const claimedRef = useRef<Set<string>>(new Set<string>());

  // 挂载时从 sessionStorage 恢复已认领集合（面板重开不重复认领）。
  useEffect(() => {
    const stored = sessionStorage.getItem(AUTO_CLAIMED_STORAGE_KEY);
    if (!stored) return;
    try {
      for (const id of JSON.parse(stored) as string[]) claimedRef.current.add(id);
    } catch {
      // 坏数据忽略，从空开始。
    }
  }, []);

  const pendingCount = useMemo(
    () =>
      zcodeAgent === null
        ? 0
        : issues.filter(
            (issue) =>
              issue.assigneeAgentId === zcodeAgent.id && !SETTLED_STATUSES.has(issue.status),
          ).length,
    [issues, zcodeAgent],
  );

  useEffect(() => {
    if (!enabled || zcodeAgent === null) return;
    const pending = issues.filter(
      (issue) =>
        issue.assigneeAgentId === zcodeAgent.id &&
        !SETTLED_STATUSES.has(issue.status) &&
        !claimedRef.current.has(issue.id),
    );
    if (pending.length === 0) return;
    for (const issue of pending) {
      claimedRef.current.add(issue.id);
      sessionStorage.setItem(
        AUTO_CLAIMED_STORAGE_KEY,
        JSON.stringify([...claimedRef.current]),
      );
      const targetWorkspacePath =
        projects.find((project) => project.id === issue.projectId)?.codebase?.localFolder ??
        null;
      void executeInZCode(issue, (claimed) => {
        onAutoExecute(claimed, targetWorkspacePath);
        toast(
          intl.formatMessage(
            { id: "paperclip.toast.autoClaimed" },
            { identifier: claimed.identifier || claimed.title || claimed.id },
          ),
        );
      });
    }
  }, [enabled, issues, zcodeAgent, projects, executeInZCode, onAutoExecute, intl]);

  return { pendingCount };
}
