/**
 * 知识库配置区：项目档案 + 构建摘要。已有档案时默认收起，浏览区让出高度。
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, FolderOpen, Search } from "lucide-react";
import type { DbBoardConnectionEntry } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
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
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { DbBoardKnowledgeBuildSection } from "@/dbBoard/DbBoardKnowledgeBuild.js";
import type { UseDbBoardKnowledgeState } from "@/dbBoard/useDbBoardKnowledge.js";

const STACK_LABELS: Record<string, string> = {
  maven: "Maven / Java",
  node: "Node 前端",
  other: "其他",
};

function connectionLabel(entry: DbBoardConnectionEntry): string {
  const label = entry.name?.trim() || `${entry.host}/${entry.database}`;
  return entry.env?.trim() ? `${label}（${entry.env.trim()}）` : label;
}

export function DbBoardKnowledgeSetup({
  state,
  connections,
}: {
  state: UseDbBoardKnowledgeState;
  connections: DbBoardConnectionEntry[];
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const [rootInput, setRootInput] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [nacosAddr, setNacosAddr] = useState("");
  const [nacosNamespace, setNacosNamespace] = useState("");
  const [nacosUsername, setNacosUsername] = useState("");
  const [nacosPassword, setNacosPassword] = useState("");
  const [dbBindingId, setDbBindingId] = useState<string>("");
  const [userOpen, setUserOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const setupOpen = !state.profile || userOpen;

  const knowledge = state.knowledge;
  const bound = connections.find(
    (entry) => entry.id === (state.profile?.dbBinding?.connectionId ?? dbBindingId),
  );
  const buildFailed = state.buildState?.status === "failed";
  const buildError = state.buildState?.error || (buildFailed ? state.buildState?.detail : undefined);

  useEffect(() => {
    if (state.profile?.projectRoot && !rootInput) {
      setRootInput(state.profile.projectRoot);
    }
    setDbBindingId(state.profile?.dbBinding?.connectionId ?? "");
  }, [state.profile]);

  const handleProbe = () => {
    if (!rootInput.trim()) return;
    void state.runProbe(rootInput);
  };

  const handleSave = () => {
    if (!rootInput.trim()) return;
    void state.saveProfile(
      {
        projectRoot: rootInput.trim(),
        ...(nacosAddr.trim()
          ? {
              nacos: {
                serverAddr: nacosAddr.trim(),
                ...(nacosNamespace.trim() ? { namespace: nacosNamespace.trim() } : {}),
                ...(nacosUsername.trim() ? { username: nacosUsername.trim() } : {}),
              },
            }
          : {}),
        ...(dbBindingId ? { dbBinding: { connectionId: dbBindingId } } : {}),
      },
      nacosPassword.trim() || undefined,
    ).then((result) => {
      if (result.ok) setUserOpen(false);
    });
  };

  const adoptDiscoveredNacos = () => {
    const discovered = state.probe?.discoveredNacos;
    if (!discovered) return;
    setNacosAddr(discovered.serverAddr);
    setNacosNamespace(discovered.namespace ?? "");
    setNacosUsername(discovered.username ?? "");
  };

  return (
    <section className="flex shrink-0 flex-col rounded-xl border border-card-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "dbboard.knowledge.projectTitle" })}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-foreground-subtle">
            {state.profile ? (
              <span className="min-w-0 truncate font-mono" title={state.profile.projectRoot}>
                {state.profile.projectRoot}
              </span>
            ) : (
              <span>{intl.formatMessage({ id: "dbboard.knowledge.noProfile" })}</span>
            )}
            {bound ? <span className="truncate">{connectionLabel(bound)}</span> : null}
            {knowledge ? (
              <span>
                {intl.formatMessage(
                  { id: "dbboard.knowledge.summary" },
                  {
                    tables: knowledge.stats.tableCount,
                    domains: knowledge.stats.domainCount,
                    distilled: knowledge.stats.distilled,
                  },
                )}
              </span>
            ) : null}
          </span>
        </div>
        {state.profile && !setupOpen ? (
          <DbBoardKnowledgeBuildSection
            compact
            hasProfile={Boolean(state.profile)}
            buildState={state.buildState}
            knowledge={knowledge}
            onStart={() => void state.startBuild()}
            onCancel={() => void state.cancelBuild()}
            onRefresh={() => void state.refreshKnowledge()}
            onDelete={() => void state.deleteKnowledge()}
          />
        ) : null}
        {state.profile ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setUserOpen((open) => !open)}
            title={intl.formatMessage({
              id: setupOpen ? "dbboard.knowledge.setupCollapse" : "dbboard.knowledge.setupExpand",
            })}
          >
            {setupOpen ? <ChevronUp /> : <ChevronDown />}
            {intl.formatMessage({
              id: setupOpen ? "dbboard.knowledge.setupCollapse" : "dbboard.knowledge.setupExpand",
            })}
          </Button>
        ) : null}
      </div>

      {buildError && !setupOpen ? (
        <button
          type="button"
          className="border-t border-border px-3 py-1.5 text-left text-ui-xs text-destructive"
          onClick={() => setErrorOpen((open) => !open)}
        >
          {errorOpen ? (
            <span className="block break-all">{buildError}</span>
          ) : (
            <span className="line-clamp-1">{buildError}</span>
          )}
        </button>
      ) : null}

      {setupOpen ? (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          <div className="flex flex-col gap-3 rounded-lg bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={rootInput}
                onChange={(event) => setRootInput(event.target.value)}
                placeholder={intl.formatMessage({ id: "dbboard.knowledge.rootPlaceholder" })}
                className="min-w-64 flex-1 font-mono text-ui-base"
              />
              <Button variant="outline" size="sm" onClick={() => setBrowserOpen(true)}>
                <FolderOpen />
                {intl.formatMessage({ id: "dbboard.knowledge.browse" })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleProbe}
                disabled={!rootInput.trim() || state.probing}
              >
                {state.probing ? <Spinner className="size-4" /> : <Search />}
                {intl.formatMessage({ id: "dbboard.knowledge.probe" })}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!rootInput.trim()}>
                {intl.formatMessage({ id: "dbboard.knowledge.saveProfile" })}
              </Button>
            </div>

            {state.probe ? (
              <div className="text-ui-sm">
                {state.probe.error ? (
                  <p className="text-destructive">{state.probe.error}</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    <p className="text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "dbboard.knowledge.probeRepos" },
                        { count: state.probe.repos.length },
                      )}
                    </p>
                    {state.probe.repos.map((repo) => (
                      <p
                        key={repo.path}
                        className="min-w-0 truncate font-mono text-ui-xs text-foreground"
                      >
                        {repo.name} · {STACK_LABELS[repo.stack] ?? repo.stack}
                      </p>
                    ))}
                    {state.probe.discoveredNacos ? (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
                        <span>
                          {intl.formatMessage({ id: "dbboard.knowledge.discoveredNacos" })}:{" "}
                          <span className="font-mono">
                            {state.probe.discoveredNacos.serverAddr}
                            {state.probe.discoveredNacos.namespace
                              ? ` / ${state.probe.discoveredNacos.namespace}`
                              : ""}
                            {state.probe.discoveredNacos.username
                              ? ` / ${state.probe.discoveredNacos.username}`
                              : ""}
                          </span>
                        </span>
                        <Button variant="ghost" size="sm" onClick={adoptDiscoveredNacos}>
                          {intl.formatMessage({ id: "dbboard.knowledge.adopt" })}
                        </Button>
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "dbboard.knowledge.dbBinding" })}</Label>
              <Select
                value={dbBindingId || "none"}
                onValueChange={(value) => setDbBindingId(value === "none" ? "" : value)}
              >
                <SelectTrigger size="sm" className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {intl.formatMessage({ id: "dbboard.knowledge.dbBindingNone" })}
                  </SelectItem>
                  {connections.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {connectionLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "dbboard.knowledge.dbBindingHint" })}
              </p>
            </div>

            <details className="text-ui-sm">
              <summary className="cursor-pointer text-foreground-subtle">
                {intl.formatMessage({ id: "dbboard.knowledge.nacosSection" })}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="dbk-nacos-addr">Nacos Server</Label>
                  <Input
                    id="dbk-nacos-addr"
                    value={nacosAddr}
                    onChange={(event) => setNacosAddr(event.target.value)}
                    placeholder="10.41.108.150:8848"
                    className="font-mono text-ui-base"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{intl.formatMessage({ id: "dbboard.knowledge.nacosNamespace" })}</Label>
                  <Input
                    value={nacosNamespace}
                    onChange={(event) => setNacosNamespace(event.target.value)}
                    className="font-mono text-ui-base"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{intl.formatMessage({ id: "dbboard.knowledge.nacosUsername" })}</Label>
                  <Input
                    value={nacosUsername}
                    onChange={(event) => setNacosUsername(event.target.value)}
                    className="font-mono text-ui-base"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{intl.formatMessage({ id: "dbboard.knowledge.nacosPassword" })}</Label>
                  <Input
                    type="password"
                    value={nacosPassword}
                    onChange={(event) => setNacosPassword(event.target.value)}
                    placeholder={intl.formatMessage({ id: "dbboard.knowledge.nacosPasswordHint" })}
                    className="font-mono text-ui-base"
                  />
                </div>
              </div>
              <p className="mt-1 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "dbboard.knowledge.nacosHint" })}
              </p>
            </details>
          </div>

          <DbBoardKnowledgeBuildSection
            embedded
            hasProfile={Boolean(state.profile)}
            buildState={state.buildState}
            knowledge={knowledge}
            onStart={() => void state.startBuild()}
            onCancel={() => void state.cancelBuild()}
            onRefresh={() => void state.refreshKnowledge()}
            onDelete={() => void state.deleteKnowledge()}
          />
        </div>
      ) : null}

      {browserOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-2 rounded-2xl border border-card-border bg-card p-4 shadow-md">
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "dbboard.knowledge.selectRoot" })}
            </span>
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              <DirectoryBrowser
                services={services}
                embedded
                onSelect={(path) => {
                  setRootInput(path);
                  setBrowserOpen(false);
                }}
                onCancel={() => setBrowserOpen(false)}
              />
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setBrowserOpen(false)}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
