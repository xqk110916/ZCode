/**
 * Paperclip 团队栏。窄屏横滑，宽屏固定在任务列表左侧。
 */
import { UserRoundPlus } from "lucide-react";
import type { PaperclipAgent, PaperclipIssue, PaperclipRunSnapshot } from "@zcode/shared";
import { paperclipAgentWorkload } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PaperclipAgentCard } from "@/paperclip/paperclipViews.js";

export function PaperclipAgentList({
  agents,
  issues,
  runsByIssueId,
  loading,
  onAdd,
  onConfigure,
  onDelete,
}: {
  agents: readonly PaperclipAgent[];
  issues: readonly PaperclipIssue[];
  runsByIssueId: Readonly<Record<string, PaperclipRunSnapshot | undefined>>;
  loading: boolean;
  onAdd: () => void;
  onConfigure: (agent: PaperclipAgent) => void;
  onDelete: (agent: PaperclipAgent) => void;
}) {
  const { intl } = useZCodeIntl();
  const ordered = [...agents].sort((a, b) => Number(b.role === "ceo") - Number(a.role === "ceo"));
  return (
    <section className="flex w-full shrink-0 flex-col gap-2 lg:w-80">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "paperclip.agents.title" })}
          <span className="font-mono text-ui-sm font-normal text-foreground-subtlest">{agents.length}</span>
        </h2>
        <Button variant="outline" size="sm" className="text-ui-sm" onClick={onAdd}>
          <UserRoundPlus className="size-4" />
          {intl.formatMessage({ id: "paperclip.addAgent.open" })}
        </Button>
      </div>
      {agents.length === 0 ? (
        loading ? (
          <div className="flex gap-2 lg:flex-col" aria-busy>
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="h-16 w-72 shrink-0 animate-pulse rounded-xl bg-surface-muted lg:w-auto" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-subtle px-3 py-4">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "paperclip.agents.emptyNew" })}
            </p>
            <Button variant="outline" size="sm" className="text-ui-sm" onClick={onAdd}>
              <UserRoundPlus className="size-4" />
              {intl.formatMessage({ id: "paperclip.addAgent.open" })}
            </Button>
          </div>
        )
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {ordered.map((agent) => {
            const workload = paperclipAgentWorkload(agent.id, issues, runsByIssueId);
            const current = workload.current;
            return (
              <div key={agent.id} className="w-72 shrink-0 lg:w-auto">
                <PaperclipAgentCard
                  agent={agent}
                  currentTitle={current?.title || current?.identifier || null}
                  queueCount={workload.queue.length}
                  onConfigure={onConfigure}
                  onDelete={onDelete}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
