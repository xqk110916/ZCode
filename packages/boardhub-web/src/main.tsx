/**
 * BoardHub 独立应用入口：不挂 ZCode Root，仅 ServiceProvider + i18n + 主题。
 * 服务端为 packages/boardhub-server（裁剪版，dev 经 vite 代理到 3210）。
 */
import { createRoot } from "react-dom/client";
import "@zcode/ui/styles.css";
import { connectViaWebSocket } from "@zcode/client";
import { createNoopWebPlatform } from "@zcode/client/web-platform";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { BoardHubApp } from "./BoardHubApp.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("BoardHub 入口缺少 #root 容器");
}
const root = createRoot(rootElement);

function BoardHubErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">BoardHub 启动失败</h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            重试
          </button>
        </section>
      </div>
    </div>
  );
}

let disconnected = false;

async function bootstrap(): Promise<void> {
  const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
  try {
    const services = await connectViaWebSocket(wsUrl, {
      // 断连只提示并允许整页重连；独立应用无需 ZCode 的多 host 恢复链路。
      onClose: () => {
        if (disconnected) return;
        disconnected = true;
        root.render(
          <BoardHubErrorScreen message="与 BoardHub 服务端的连接已断开（服务是否仍在运行？）" />,
        );
      },
    });
    document.title = "BoardHub";
    root.render(
      <ZCodeIntlProvider>
        <PlatformProvider platform={createNoopWebPlatform()}>
          <ServiceProvider services={services}>
            <BoardHubApp />
          </ServiceProvider>
        </PlatformProvider>
      </ZCodeIntlProvider>,
    );
  } catch (error) {
    root.render(
      <BoardHubErrorScreen message={error instanceof Error ? error.message : String(error)} />,
    );
  }
}

void bootstrap();
