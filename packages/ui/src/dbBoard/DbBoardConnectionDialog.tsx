/**
 * 数据库看板连接配置对话框：名称/环境 + host/port/database/username/password + 测试连接 + 保存。
 * 支持两种模式：editing 非空 = 更新该连接（id 不变）；null = 新建连接。
 * 密码保存走服务端 credentialService（按连接 id 加密隔离），编辑时留空表示沿用已存密码。
 */
import { useEffect, useState } from "react";
import { randomUUID } from "@/dbBoard/connectionId.js";
import type { DbBoardConnectionConfig, DbBoardConnectionEntry } from "@zcode/services";
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
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DbBoardConnectionDialog({
  open,
  onOpenChange,
  editing,
  onSave,
  onTest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑的连接（null = 新建）。 */
  editing: DbBoardConnectionEntry | null;
  onSave: (entry: DbBoardConnectionEntry, password?: string) => Promise<{ ok: boolean; error?: string }>;
  onTest: (
    config: DbBoardConnectionConfig,
    password?: string,
    connectionId?: string,
  ) => Promise<{ ok: boolean; error?: string; serverVersion?: string }>;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [env, setEnv] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("54321");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(
        editing?.name?.trim() ||
          (editing ? `${editing.host}/${editing.database}` : ""),
      );
      setEnv(editing?.env ?? "");
      setHost(editing?.host ?? "");
      setPort(String(editing?.port ?? 54321));
      setDatabase(editing?.database ?? "");
      setUsername(editing?.username ?? "");
      setPassword("");
      setTestResult(null);
    }
  }, [open, editing]);

  const buildConfig = (): DbBoardConnectionConfig | null => {
    const portNumber = Number(port);
    if (!host.trim() || !database.trim() || !username.trim() || !Number.isInteger(portNumber)) {
      return null;
    }
    return {
      host: host.trim(),
      port: portNumber,
      database: database.trim(),
      username: username.trim(),
    };
  };

  const handleTest = async () => {
    const config = buildConfig();
    if (!config) {
      setTestResult({ ok: false, message: intl.formatMessage({ id: "dbboard.connection.invalid" }) });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(config, password.trim() || undefined, editing?.id);
      setTestResult(
        result.ok
          ? {
              ok: true,
              message: intl.formatMessage(
                { id: "dbboard.connection.testOk" },
                { version: result.serverVersion ?? "" },
              ),
            }
          : {
              ok: false,
              message: intl.formatMessage(
                { id: "dbboard.connection.testFailed" },
                { error: result.error ?? "" },
              ),
            },
      );
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const config = buildConfig();
    if (!config) {
      setTestResult({ ok: false, message: intl.formatMessage({ id: "dbboard.connection.invalid" }) });
      return;
    }
    setSaving(true);
    try {
      const entry: DbBoardConnectionEntry = {
        id: editing?.id ?? randomUUID(),
        ...config,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(env.trim() ? { env: env.trim() } : {}),
      };
      const result = await onSave(entry, password.trim() || undefined);
      if (result.ok) {
        onOpenChange(false);
      } else {
        setTestResult({
          ok: false,
          message: result.error ?? intl.formatMessage({ id: "dbboard.connection.testFailed" }, { error: "" }),
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: editing ? "dbboard.connection.editTitle" : "dbboard.connection.title",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "dbboard.connection.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbboard-name">
                {intl.formatMessage({ id: "dbboard.connection.name" })}
              </Label>
              <Input
                id="dbboard-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={intl.formatMessage({ id: "dbboard.connection.namePlaceholder" })}
                className="text-ui-base"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbboard-env">
                {intl.formatMessage({ id: "dbboard.connection.env" })}
              </Label>
              <Input
                id="dbboard-env"
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                placeholder="dev / test / prod"
                className="text-ui-base"
              />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbboard-host">Host</Label>
              <Input
                id="dbboard-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                className="font-mono text-ui-base"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dbboard-port">Port</Label>
              <Input
                id="dbboard-port"
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
                className="font-mono text-ui-base"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbboard-database">
              {intl.formatMessage({ id: "dbboard.connection.database" })}
            </Label>
            <Input
              id="dbboard-database"
              value={database}
              onChange={(event) => setDatabase(event.target.value)}
              className="font-mono text-ui-base"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbboard-username">
              {intl.formatMessage({ id: "dbboard.connection.username" })}
            </Label>
            <Input
              id="dbboard-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="font-mono text-ui-base"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbboard-password">
              {intl.formatMessage({ id: "dbboard.connection.password" })}
            </Label>
            <Input
              id="dbboard-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={intl.formatMessage({
                id: editing
                  ? "dbboard.connection.passwordKeepPlaceholder"
                  : "dbboard.connection.passwordPlaceholder",
              })}
              className="font-mono text-ui-base"
            />
          </div>
          {testResult ? (
            <div
              className={
                testResult.ok
                  ? "rounded-lg bg-surface px-3 py-2 text-ui-xs text-foreground-subtle"
                  : "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive"
              }
            >
              {testResult.message}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
            {testing ? <Spinner className="size-4" /> : null}
            {intl.formatMessage({
              id: testing ? "dbboard.connection.testing" : "dbboard.connection.test",
            })}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || !buildConfig()}>
            {intl.formatMessage({ id: "dbboard.connection.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
