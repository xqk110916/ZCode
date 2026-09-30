import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  CreateGuideEntryInput,
  ZCodeGuideEntry,
} from "#src/customResources/guideEntryStore.js";

export interface NativeDirectoryPickResult {
  /** 服务端是否具备原生选择能力（Windows 且 PowerShell 可用）；false 时调用方走降级。 */
  supported: boolean;
  /** 用户选中的绝对路径；取消时为 null（仅在 supported=true 时有意义）。 */
  path: string | null;
}

export type { CreateGuideEntryInput, ZCodeGuideEntry } from "#src/customResources/guideEntryStore.js";

/**
 * IGuideEntryService — 设置「引导(新)」的项目引导记录服务（specs/ui/settings-guide-new.md）。
 * 记录属于本机事实源（本地文件夹路径），UI 侧分区应经 localHost services 访问。
 */
export interface IGuideEntryService {
  /** 按创建时间倒序列出全部引导记录。 */
  list(): Promise<ZCodeGuideEntry[]>;

  /**
   * 新建引导记录。名称 trim 后非空、前后端路径各至少 1 条，否则抛错；
   * 路径去重保序（前端在前、后端在后）。
   */
  create(params: CreateGuideEntryInput): Promise<ZCodeGuideEntry>;

  /** 删除引导记录（幂等；不影响已添加的工作区项目 tab）。 */
  delete(params: { entryId: string }): Promise<void>;

  /**
   * 在 server（Windows）桌面弹出系统原生文件夹选择器并回传选中路径。
   * Web 客户端自身无法打开系统目录框，server 与用户同机开发时由本方法代弹；
   * supported=false（非 Windows / 能力缺失）时调用方降级到服务端目录浏览器。
   */
  pickDirectory(params?: { description?: string }): Promise<NativeDirectoryPickResult>;
}

export const IGuideEntryService = createServiceDescriptor<IGuideEntryService>(
  ServiceChannels.GuideEntry,
);

export function createGuideEntryService(
  store: {
    list(): Promise<ZCodeGuideEntry[]>;
    create(input: CreateGuideEntryInput): Promise<ZCodeGuideEntry>;
    delete(entryId: string): Promise<void>;
  },
  options: {
    /**
     * 原生文件夹选择器实现（Windows FolderBrowserDialog，见 nativeDirectoryPicker.ts）。
     * 本模块会被浏览器包（描述符）引用，不能静态 import Node 依赖；由 server 组合根
     * （node.ts）注入。缺省返回不支持，UI 据此降级到服务端目录浏览器。
     */
    pickNativeDirectory?: (description: string) => Promise<NativeDirectoryPickResult>;
  } = {},
): IGuideEntryService {
  const pickNativeDirectory: (description: string) => Promise<NativeDirectoryPickResult> =
    options.pickNativeDirectory ?? (async () => ({ supported: false, path: null }));
  return {
    async list() {
      return store.list();
    },
    async create(params) {
      const name = params.name.trim();
      if (!name) {
        throw new Error("引导记录名称不能为空");
      }
      const dedupe = (paths: string[]): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const path of paths) {
          const trimmed = path.trim();
          if (!trimmed || seen.has(trimmed)) continue;
          seen.add(trimmed);
          result.push(trimmed);
        }
        return result;
      };
      const frontendPaths = dedupe(params.frontendPaths);
      const backendPaths = dedupe(params.backendPaths);
      if (frontendPaths.length === 0 || backendPaths.length === 0) {
        throw new Error("前端代码与后端代码各至少需要选择一个项目文件夹");
      }
      return store.create({ ...params, name, frontendPaths, backendPaths });
    },
    async delete(params) {
      await store.delete(params.entryId);
    },
    async pickDirectory(params) {
      return pickNativeDirectory(params?.description ?? "");
    },
  };
}
