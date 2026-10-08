/**
 * Paperclip 任务执行进度。
 *
 * issue 状态只说明流程走到哪一步。这里另拉 heartbeat（live + 最近摘要）和评论，
 * 让面板能直接看到「谁在跑、跑了多久、刚写了什么」。连接中靠事件防抖刷新，
 * 有进行中的任务时 8 秒再兜一次；WS 降级为轮询时固定 8 秒，不依赖推送。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipIssueComment,
  PaperclipIssueEvent,
  PaperclipRunSnapshot,
} from "@zcode/shared";
import {
  latestPaperclipRunForIssue,
  mergePaperclipComment,
  paperclipHasLiveWork,
  paperclipIssueNeedsHuman,
  paperclipRunsForIssue,
  selectPaperclipCommentIssueIds,
  upsertPaperclipRun,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const POLL_MS = 8_000;
const EVENT_DEBOUNCE_MS = 1_500;
const MAX_INTERACTION_FETCHES = 12;

export interface PaperclipIssueWriteToken {
  epoch: number;
  seq: number;
}

export function usePaperclipActivity(input: {
  /** connected 走事件 + 有活才轮询；polling 固定轮询；off 不请求。 */
  mode: "connected" | "polling" | "off";
  issues: readonly PaperclipIssue[];
  /** 安静写回 issue 列表（不转刷新按钮）。token 对不上就丢弃，避免盖住更新的写入。 */
  onIssues: (issues: PaperclipIssue[], token: PaperclipIssueWriteToken) => void;
  getIssueToken: () => PaperclipIssueWriteToken;
}): {
  runsByIssueId: Readonly<Record<string, PaperclipRunSnapshot>>;
  runHistoryByIssueId: Readonly<Record<string, PaperclipRunSnapshot[]>>;
  commentsByIssueId: Readonly<Record<string, PaperclipIssueComment[]>>;
  interactionsByIssueId: Readonly<Record<string, PaperclipInteraction[]>>;
  loadIssueThread: (issueId: string) => Promise<void>;
} {
  const services = useServices();
  const paperclipService = services.paperclipService;
  const [runs, setRuns] = useState<PaperclipRunSnapshot[]>([]);
  const [commentsByIssueId, setCommentsByIssueId] = useState<Record<string, PaperclipIssueComment[]>>(
    {},
  );
  const [interactionsByIssueId, setInteractionsByIssueId] = useState<
    Record<string, PaperclipInteraction[]>
  >({});
  const interactionsRef = useRef(interactionsByIssueId);
  interactionsRef.current = interactionsByIssueId;
  const issuesRef = useRef(input.issues);
  issuesRef.current = input.issues;
  const onIssuesRef = useRef(input.onIssues);
  onIssuesRef.current = input.onIssues;
  const getTokenRef = useRef(input.getIssueToken);
  getTokenRef.current = input.getIssueToken;
  const epochRef = useRef(0);
  const quietEpochRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!paperclipService) return;
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    const seenToken = getTokenRef.current();
    const quietToken = quietEpochRef.current + 1;
    quietEpochRef.current = quietToken;
    void paperclipService
      .listIssues()
      .then((nextIssues) => {
        if (quietEpochRef.current !== quietToken) return;
        onIssuesRef.current(nextIssues, seenToken);
      })
      .catch((error: unknown) => {
        logger.warn("paperclip issue progress refresh failed", { error });
      });
    let nextRuns: PaperclipRunSnapshot[] = [];
    try {
      nextRuns = await paperclipService.listRunSnapshots();
    } catch (error) {
      logger.warn("paperclip run snapshot failed", { error });
      return;
    }
    if (epochRef.current !== epoch) return;
    setRuns(nextRuns);
    const ids = selectPaperclipCommentIssueIds(issuesRef.current, nextRuns);
    const entries = await Promise.all(
      ids.map(async (issueId) => {
        try {
          return [issueId, await paperclipService.listIssueComments(issueId)] as const;
        } catch (error) {
          logger.warn("paperclip issue comments failed", { error, issueId });
          return [issueId, null] as const;
        }
      }),
    );
    if (epochRef.current !== epoch) return;
    setCommentsByIssueId((current) => {
      let changed = false;
      const next = { ...current };
      for (const [issueId, list] of entries) {
        if (!list) continue;
        next[issueId] = list;
        changed = true;
      }
      return changed ? next : current;
    });
    const interactionIds = selectInteractionIssueIds(issuesRef.current, interactionsRef.current);
    const interactionEntries = await Promise.all(
      interactionIds.map(async (issueId) => {
        try {
          return [issueId, await paperclipService.listIssueInteractions(issueId)] as const;
        } catch (error) {
          logger.warn("paperclip issue interactions failed", { error, issueId });
          return [issueId, null] as const;
        }
      }),
    );
    if (epochRef.current !== epoch) return;
    setInteractionsByIssueId((current) => {
      let changed = false;
      const next = { ...current };
      for (const [issueId, list] of interactionEntries) {
        if (!list) continue;
        next[issueId] = list;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [paperclipService]);

  const schedule = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void refresh();
    }, EVENT_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    if (input.mode === "off") return;
    void refresh();
  }, [input.mode, refresh]);

  useEffect(() => {
    if (!paperclipService || input.mode === "off") return;
    const subscription = paperclipService.onDidReceiveIssueEvent((event) => {
      applyLiveEvent(event, setRuns, setCommentsByIssueId);
      const raw = (event.rawType ?? "").toLowerCase();
      if (
        event.run ||
        event.comment ||
        raw.includes("heartbeat") ||
        raw.includes("comment") ||
        raw.includes("run") ||
        raw.includes("interaction")
      ) {
        schedule();
      }
    });
    return () => subscription.dispose();
  }, [paperclipService, input.mode, schedule]);

  const live = paperclipHasLiveWork(input.issues, runs);
  useEffect(() => {
    if (input.mode === "off") return;
    if (input.mode === "connected" && !live) return;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [input.mode, live, refresh]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const loadIssueThread = useCallback(
    async (issueId: string) => {
      if (!paperclipService) return;
      const [commentsResult, interactionsResult, runsResult] = await Promise.allSettled([
        paperclipService.listIssueComments(issueId),
        paperclipService.listIssueInteractions(issueId),
        paperclipService.listIssueRuns(issueId),
      ]);
      if (commentsResult.status === "fulfilled") {
        setCommentsByIssueId((current) => ({ ...current, [issueId]: commentsResult.value }));
      } else {
        logger.warn("paperclip issue comments failed", { error: commentsResult.reason, issueId });
      }
      if (interactionsResult.status === "fulfilled") {
        setInteractionsByIssueId((current) => ({ ...current, [issueId]: interactionsResult.value }));
      } else {
        logger.warn("paperclip issue interactions failed", { error: interactionsResult.reason, issueId });
      }
      if (runsResult.status === "fulfilled") {
        setRuns((current) => runsResult.value.reduce(upsertPaperclipRun, current));
      } else {
        logger.warn("paperclip issue runs failed", { error: runsResult.reason, issueId });
      }
    },
    [paperclipService],
  );

  const runsByIssueId = useMemo(() => {
    const map: Record<string, PaperclipRunSnapshot> = {};
    const issueIds = new Set(runs.flatMap((run) => (run.issueId ? [run.issueId] : [])));
    for (const issueId of issueIds) {
      const latest = latestPaperclipRunForIssue(runs, issueId);
      if (latest) map[issueId] = latest;
    }
    return map;
  }, [runs]);

  const runHistoryByIssueId = useMemo(() => {
    const map: Record<string, PaperclipRunSnapshot[]> = {};
    for (const issueId of Object.keys(runsByIssueId)) {
      map[issueId] = paperclipRunsForIssue(runs, issueId);
    }
    for (const run of runs) {
      if (!run.issueId || map[run.issueId]) continue;
      map[run.issueId] = paperclipRunsForIssue(runs, run.issueId);
    }
    return map;
  }, [runs, runsByIssueId]);

  return {
    runsByIssueId,
    runHistoryByIssueId,
    commentsByIssueId,
    interactionsByIssueId,
    loadIssueThread,
  };
}

function selectInteractionIssueIds(
  issues: readonly PaperclipIssue[],
  known: Readonly<Record<string, PaperclipInteraction[]>>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id) || ids.length >= MAX_INTERACTION_FETCHES) return;
    seen.add(id);
    ids.push(id);
  };
  for (const [issueId, list] of Object.entries(known)) {
    if (paperclipIssueNeedsHuman(list)) push(issueId);
  }
  const ranked = [...issues].sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? a.createdAt ?? "") || 0;
    const tb = Date.parse(b.updatedAt ?? b.createdAt ?? "") || 0;
    return tb - ta;
  });
  for (const issue of ranked) {
    if (issue.status === "done" || issue.status === "cancelled") continue;
    push(issue.id);
  }
  return ids;
}

function applyLiveEvent(
  event: PaperclipIssueEvent,
  setRuns: (update: (current: PaperclipRunSnapshot[]) => PaperclipRunSnapshot[]) => void,
  setComments: (
    update: (
      current: Record<string, PaperclipIssueComment[]>,
    ) => Record<string, PaperclipIssueComment[]>,
  ) => void,
): void {
  if (event.run) {
    const run = event.run;
    setRuns((current) => upsertPaperclipRun(current, run));
  }
  if (event.comment && event.issueId) {
    const comment = event.comment;
    const targetId = event.issueId;
    setComments((current) => ({
      ...current,
      [targetId]: mergePaperclipComment(current[targetId] ?? [], comment),
    }));
  }
}
