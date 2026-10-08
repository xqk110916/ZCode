/**
 * 任务展开区：等人处理的交互、审查交接、回复、心跳历史、评论。
 */
import { useState } from "react";
import type {
  PaperclipAgent,
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipIssueComment,
  PaperclipQuestion,
  PaperclipRunSnapshot,
} from "@zcode/shared";
import { isPaperclipDecisionInteraction, isPaperclipInteractionPending } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { findAgentName, formatTimestamp } from "@/paperclip/paperclipViews.js";

function commentAuthor(
  comment: PaperclipIssueComment,
  agents: readonly PaperclipAgent[],
  fallback: (id: string) => string,
): string {
  if (comment.authorName) return comment.authorName;
  if (comment.authorAgentId) {
    return findAgentName(agents, comment.authorAgentId) ?? fallback("paperclip.progress.authorAgent");
  }
  if (comment.authorKind === "user") return fallback("paperclip.progress.authorUser");
  if (comment.authorKind === "system") return fallback("paperclip.progress.authorSystem");
  return fallback("paperclip.progress.authorAgent");
}

function runStatusMessage(status: string): string {
  switch (status.toLowerCase()) {
    case "queued":
    case "pending":
    case "scheduled_retry":
      return "paperclip.progress.queued";
    case "running":
      return "paperclip.progress.running";
    case "failed":
    case "timed_out":
    case "interrupted":
    case "error":
      return "paperclip.progress.failed";
    case "succeeded":
      return "paperclip.progress.done";
    case "cancelled":
      return "paperclip.progress.cancelled";
    default:
      return "";
  }
}

function interactionMessage(kind: string): string {
  if (kind === "ask_user_questions") return "paperclip.interaction.question";
  if (kind === "suggest_tasks") return "paperclip.interaction.suggest";
  return "paperclip.interaction.confirm";
}

function toggleSelection(current: readonly string[], id: string, mode: "single" | "multi"): string[] {
  if (mode === "single") return [id];
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

function OptionList({
  name,
  mode,
  options,
  selected,
  onToggle,
}: {
  name: string;
  mode: "single" | "multi";
  options: ReadonlyArray<{ id: string; label: string }>;
  selected: readonly string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {options.map((option) => (
        <label key={option.id} className="flex items-start gap-2 text-ui-sm text-foreground">
          <input
            type={mode === "multi" ? "checkbox" : "radio"}
            name={name}
            className="mt-1"
            checked={selected.includes(option.id)}
            onChange={() => onToggle(option.id)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function QuestionBlock({
  interactionId,
  question,
  selected,
  onToggle,
}: {
  interactionId: string;
  question: PaperclipQuestion;
  selected: readonly string[];
  onToggle: (questionId: string, optionId: string, mode: "single" | "multi") => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-ui-sm text-foreground">{question.prompt}</legend>
      <OptionList
        name={`${interactionId}:${question.id}`}
        mode={question.selectionMode}
        options={question.options}
        selected={selected}
        onToggle={(optionId) => onToggle(question.id, optionId, question.selectionMode)}
      />
    </fieldset>
  );
}

export function PaperclipIssueDetail({
  issue,
  locale,
  agents,
  comments,
  runs,
  interactions,
  canComplete,
  onReply,
  onAcceptReview,
  onSendBack,
  onAcceptInteraction,
  onRejectInteraction,
  onRespondInteraction,
}: {
  issue: PaperclipIssue;
  locale: string;
  agents: readonly PaperclipAgent[];
  comments: readonly PaperclipIssueComment[];
  runs: readonly PaperclipRunSnapshot[];
  interactions: readonly PaperclipInteraction[];
  canComplete: boolean;
  onReply: (body: string) => Promise<boolean>;
  onAcceptReview: (comment: string) => Promise<boolean>;
  onSendBack: (comment: string) => Promise<boolean>;
  onAcceptInteraction: (interactionId: string, selectedOptionIds: string[]) => Promise<boolean>;
  onRejectInteraction: (interactionId: string) => Promise<boolean>;
  onRespondInteraction: (
    interactionId: string,
    answers: ReadonlyArray<{ questionId: string; optionIds: string[] }>,
  ) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [reply, setReply] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [sending, setSending] = useState(false);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const pending = interactions.filter(isPaperclipInteractionPending);
  const pendingDecision = pending.some(isPaperclipDecisionInteraction);
  const showReview = issue.status === "in_review" && !pendingDecision;
  const label = (id: string) => intl.formatMessage({ id });

  function selectedFor(key: string): string[] {
    return selections[key] ?? [];
  }

  function toggle(key: string, id: string, mode: "single" | "multi") {
    setSelections((current) => ({
      ...current,
      [key]: toggleSelection(current[key] ?? [], id, mode),
    }));
  }

  async function sendReply() {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const ok = await onReply(body);
      if (ok) setReply("");
    } finally {
      setSending(false);
    }
  }

  async function review(accept: boolean) {
    if (sending) return;
    if (accept && !canComplete) return;
    setSending(true);
    try {
      const note = reviewNote.trim();
      const ok = accept ? await onAcceptReview(note) : await onSendBack(note);
      if (ok) setReviewNote("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border-subtle px-4 py-3">
      {issue.description?.trim() ? (
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
          {issue.description}
        </p>
      ) : null}

      {pending.map((interaction) => {
        const optionKey = `${interaction.id}:options`;
        const questionsReady =
          interaction.questions.length === 0 ||
          interaction.questions.every((question) => {
            if (question.options.length === 0) return true;
            return selectedFor(`${interaction.id}:${question.id}`).length > 0;
          });
        return (
          <div key={interaction.id} className="flex flex-col gap-2 rounded-lg bg-warning-subtle px-3 py-2">
            <p className="text-ui-sm font-medium text-foreground">
              {interaction.title ?? label(interactionMessage(interaction.kind))}
            </p>
            {interaction.summary ? (
              <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
                {interaction.summary}
              </p>
            ) : null}
            {interaction.questions.map((question) => (
              <QuestionBlock
                key={question.id}
                interactionId={interaction.id}
                question={question}
                selected={selectedFor(`${interaction.id}:${question.id}`)}
                onToggle={(questionId, optionId, mode) =>
                  toggle(`${interaction.id}:${questionId}`, optionId, mode)
                }
              />
            ))}
            {interaction.questions.length === 0 && interaction.options.length > 0 ? (
              <OptionList
                name={optionKey}
                mode="multi"
                options={interaction.options}
                selected={selectedFor(optionKey)}
                onToggle={(optionId) => toggle(optionKey, optionId, "multi")}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              {interaction.questions.length > 0 ? (
                <Button
                  size="sm"
                  className="text-ui-sm"
                  disabled={sending || !questionsReady}
                  onClick={() => {
                    setSending(true);
                    void onRespondInteraction(
                      interaction.id,
                      interaction.questions.map((question) => ({
                        questionId: question.id,
                        optionIds: selectedFor(`${interaction.id}:${question.id}`),
                      })),
                    ).finally(() => setSending(false));
                  }}
                >
                  {label("paperclip.interaction.submit")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="text-ui-sm"
                  disabled={sending}
                  onClick={() => {
                    const selected = selectedFor(optionKey);
                    setSending(true);
                    void onAcceptInteraction(interaction.id, selected).finally(() => setSending(false));
                  }}
                >
                  {label("paperclip.interaction.accept")}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-ui-sm"
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  void onRejectInteraction(interaction.id).finally(() => setSending(false));
                }}
              >
                {label("paperclip.interaction.reject")}
              </Button>
            </div>
          </div>
        );
      })}

      {showReview ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder={label("paperclip.issues.reviewNotePlaceholder")}
            className="min-h-16 text-ui-sm"
          />
          {!canComplete ? (
            <p className="text-ui-sm text-warning">{label("paperclip.issues.cannotComplete")}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="text-ui-sm"
              disabled={sending || !canComplete}
              data-testid="paperclip-accept-review"
              onClick={() => void review(true)}
            >
              {label("paperclip.issues.acceptReview")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-ui-sm"
              disabled={sending}
              data-testid="paperclip-send-back"
              onClick={() => void review(false)}
            >
              {label("paperclip.issues.sendBack")}
            </Button>
          </div>
        </div>
      ) : null}

      {issue.status !== "cancelled" ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void sendReply();
              }
            }}
            placeholder={label("paperclip.issues.replyPlaceholder")}
            className="min-h-16 text-ui-sm"
            data-testid="paperclip-reply"
          />
          <div>
            <Button
              variant="outline"
              size="sm"
              className="text-ui-sm"
              disabled={sending || reply.trim() === ""}
              onClick={() => void sendReply()}
            >
              {label("paperclip.issues.sendReply")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-ui-xs font-medium text-foreground-subtlest">
          {label("paperclip.progress.history")}
        </p>
        {runs.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">{label("paperclip.progress.noHistory")}</p>
        ) : (
          <ol className="flex max-h-48 flex-col gap-2 overflow-y-auto">
            {runs.map((run) => {
              const statusId = runStatusMessage(run.status);
              const failed = ["failed", "timed_out", "interrupted", "error"].includes(run.status.toLowerCase());
              return (
                <li key={run.id} className="rounded-lg bg-surface-muted px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-ui-xs text-foreground-subtlest">
                    <span className={cn(failed && "text-danger")}>
                      {statusId ? label(statusId) : run.status}
                    </span>
                    <span className="shrink-0">
                      {formatTimestamp(run.startedAt ?? run.createdAt, locale)}
                    </span>
                  </div>
                  {run.error ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-ui-sm text-danger">{run.error}</p>
                  ) : run.detail ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
                      {run.detail}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-ui-xs font-medium text-foreground-subtlest">
          {label("paperclip.progress.comments")}
        </p>
        {comments.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">{label("paperclip.progress.noActivity")}</p>
        ) : (
          <ol className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-lg bg-surface-muted px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-ui-xs text-foreground-subtlest">
                  <span className="truncate">{commentAuthor(comment, agents, label)}</span>
                  <span className="shrink-0">{formatTimestamp(comment.createdAt, locale)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
                  {comment.body}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
