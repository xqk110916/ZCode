import { appSettingsSchema, type AppSettings } from "@zcode/shared";
import type { ProjectSessionStore } from "#src/customResources/projectSessionStore.js";

/**
 * settingService 的项目会话路由辅助（specs/services/custom-resource-store.md）：
 * 项目三字段以 custom-resources KV 为唯一事实源，setting.json 旧值不透出（从零开始语义）。
 */
export function createProjectSessionRouting(store: ProjectSessionStore) {
  const readProjectSessionOverlay = async (): Promise<
    Pick<AppSettings, "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex">
  > => {
    const defaults = appSettingsSchema.parse({});
    try {
      const patch = await store.read();
      return {
        lastWorkspaceSession: patch.lastWorkspaceSession ?? defaults.lastWorkspaceSession,
        recentProjects: patch.recentProjects ?? defaults.recentProjects,
        lastActiveTabIndex: patch.lastActiveTabIndex ?? defaults.lastActiveTabIndex,
      };
    } catch (error) {
      // KV 读取失败回退 schema 默认值，不阻塞整体设置读取。
      console.log("[settingService:project-session] read kv failed, using defaults:", error);
      return {
        lastWorkspaceSession: defaults.lastWorkspaceSession,
        recentProjects: defaults.recentProjects,
        lastActiveTabIndex: defaults.lastActiveTabIndex,
      };
    }
  };

  const applyProjectSessionOverlay = async (settings: AppSettings): Promise<AppSettings> => ({
    ...settings,
    ...(await readProjectSessionOverlay()),
  });

  return { readProjectSessionOverlay, applyProjectSessionOverlay };
}
