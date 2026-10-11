import { appSettingsPatchSchema, appSettingsSchema, type AppSettings } from "@zcode/shared";
import type { ProjectSessionPatch, ProjectSessionStore } from "#src/customResources/projectSessionStore.js";

const MAX_RECENT_PROJECTS = 10;

/**
 * settingService 的项目会话路由辅助（specs/services/custom-resource-store.md）：
 * 项目三字段以 custom-resources KV 为唯一事实源，setting.json 旧值不透出（从零开始语义）。
 * update 的「split → 合并 → recentProjects 去重上限 → 双写」整段收敛在此，
 * settingService.update 只做一次调用，避免其文件行数超出门禁。
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

  /** 队列内合并项目字段：基于 KV 最新值合并补丁，recentProjects 去重并截断到上限。 */
  const mergeProjectSessionPatch = async (
    patch: ProjectSessionPatch,
  ): Promise<ProjectSessionPatch> => {
    // 打开工作区后会几乎同时写 recentProjects 和 lastWorkspaceSession；
    // 各自在队列内基于最新 KV 状态合并，后写不抹前写。去重上限逻辑随项目字段落 KV。
    const merged = appSettingsPatchSchema.parse({
      ...(await readProjectSessionOverlay()),
      ...patch,
    }) as ProjectSessionPatch;
    if (merged.recentProjects) {
      merged.recentProjects = [...new Set(merged.recentProjects)].slice(0, MAX_RECENT_PROJECTS);
    }
    return merged;
  };

  return { readProjectSessionOverlay, applyProjectSessionOverlay, mergeProjectSessionPatch };
}
