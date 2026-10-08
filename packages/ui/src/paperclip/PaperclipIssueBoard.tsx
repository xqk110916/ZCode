/**
 * 任务树。父任务挂子任务；筛选命中子任务时仍保留祖先。
 * Paperclip 是事实源，这里只投影 parentId。
 */
import { useMemo } from "react";
import type {
  PaperclipAgent,
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipIssueComment,
  PaperclipIssueStatus,
  PaperclipIssueTreeNode,
  PaperclipRunSnapshot,
} from "@zcode/shared";
import {
  filterPaperclipForest,
  groupPaperclipIssues,
  paperclipBlockerIds,
  paperclipChildProgress,
  paperclipIssueNeedsHuman,
  paperclipIssueSettled,
  paperclipOpenDescendantCount,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PaperclipIssueRow } from "@/paperclip/PaperclipIssueRow.js";

export type PaperclipIssueFilter = PaperclipIssueStatus | "all" | "needs_you";

interface BoardModel {
  locale: string;
  issues: readonly PaperclipIssue[];
  agents: readonly PaperclipAgent[];
  runsByIssueId: Readonly<Record<string, PaperclipRunSnapshot | undefined>>;
  runHistoryByIssueId: Readonly<Record<string, readonly PaperclipRunSnapshot[] | undefined>>;
  commentsByIssueId: Readonly<Record<string, readonly PaperclipIssueComment[] | undefined>>;
  interactionsByIssueId: Readonly<Record<string, readonly PaperclipInteraction[] | undefined>>;
  onOpen: (issueId: string) => void;
  onMarkDone: (issueId: string) => void;
  onAcceptReview: (issueId: string, comment: string) => Promise<boolean>;
  onSendBack: (issueId: string, comment: string) => Promise<boolean>;
  onReply: (issueId: string, body: string) => Promise<boolean>;
  onAcceptInteraction: (
    issueId: string,
    interactionId: string,
    selectedOptionIds: string[],
  ) => Promise<boolean>;
  onRejectInteraction: (issueId: string, interactionId: string) => Promise<boolean>;
  onRespondInteraction: (
    issueId: string,
    interactionId: string,
    answers: ReadonlyArray<{ questionId: string; optionIds: string[] }>,
  ) => Promise<boolean>;
}

function issueTime(issue: PaperclipIssue): number {
  const parsed = Date.parse(issue.updatedAt ?? issue.createdAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function subtreeOpen(node: PaperclipIssueTreeNode): boolean {
  if (!paperclipIssueSettled(node.issue.status)) return true;
  return node.children.some(subtreeOpen);
}

function sortForest(nodes: readonly PaperclipIssueTreeNode[]): PaperclipIssueTreeNode[] {
  return nodes
    .map((node) => ({ issue: node.issue, children: sortForest(node.children) }))
    .sort((a, b) => {
      const openDelta = Number(subtreeOpen(b)) - Number(subtreeOpen(a));
      if (openDelta !== 0) return openDelta;
      return issueTime(b.issue) - issueTime(a.issue);
    });
}

function blockerLabel(id: string, issues: readonly PaperclipIssue[]): string {
  const found = issues.find((issue) => issue.id === id);
  return found?.identifier || found?.title || id;
}

function IssueBranch({ node, model }: { node: PaperclipIssueTreeNode; model: BoardModel }) {
  const issue = node.issue;
  const openDescendants = paperclipOpenDescendantCount(issue.id, model.issues);
  return (
    <li className="flex flex-col gap-2">
      <PaperclipIssueRow
        issue={issue}
        locale={model.locale}
        assignee={model.agents.find((agent) => agent.id === issue.assigneeAgentId) ?? null}
        agents={model.agents}
        run={model.runsByIssueId[issue.id] ?? null}
        runs={model.runHistoryByIssueId[issue.id] ?? []}
        comments={model.commentsByIssueId[issue.id] ?? []}
        interactions={model.interactionsByIssueId[issue.id] ?? []}
        childProgress={paperclipChildProgress(issue.id, model.issues)}
        openDescendants={openDescendants}
        blockerLabels={paperclipBlockerIds(issue).map((id) => blockerLabel(id, model.issues))}
        onMarkDone={() => model.onMarkDone(issue.id)}
        onOpen={() => model.onOpen(issue.id)}
        onReply={(body) => model.onReply(issue.id, body)}
        onAcceptReview={(comment) => model.onAcceptReview(issue.id, comment)}
        onSendBack={(comment) => model.onSendBack(issue.id, comment)}
        onAcceptInteraction={(interactionId, selectedOptionIds) =>
          model.onAcceptInteraction(issue.id, interactionId, selectedOptionIds)
        }
        onRejectInteraction={(interactionId) => model.onRejectInteraction(issue.id, interactionId)}
        onRespondInteraction={(interactionId, answers) =>
          model.onRespondInteraction(issue.id, interactionId, answers)
        }
      />
      {node.children.length > 0 ? (
        <ul className="ml-3 flex flex-col gap-2 border-l border-border-subtle pl-3">
          {node.children.map((child) => (
            <IssueBranch key={child.issue.id} node={child} model={model} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function PaperclipIssueBoard({
  filter,
  loading,
  ...model
}: BoardModel & { filter: PaperclipIssueFilter; loading: boolean }) {
  const { intl } = useZCodeIntl();
  const forest = useMemo(() => {
    const grouped = groupPaperclipIssues(model.issues);
    const filtered =
      filter === "all"
        ? grouped
        : filterPaperclipForest(grouped, (issue) =>
            filter === "needs_you"
              ? paperclipIssueNeedsHuman(model.interactionsByIssueId[issue.id])
              : issue.status === filter,
          );
    return sortForest(filtered);
  }, [model.issues, model.interactionsByIssueId, filter]);

  if (forest.length === 0) {
    if (loading) {
      return (
        <ul className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="h-[52px] animate-pulse rounded-lg bg-surface-muted" />
          ))}
        </ul>
      );
    }
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: filter === "all" ? "paperclip.issues.empty" : "paperclip.issues.emptyFiltered",
        })}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {forest.map((node) => (
        <IssueBranch key={node.issue.id} node={node} model={model} />
      ))}
    </ul>
  );
}
