/**
 * 项目业务知识库服务（node-only 编排层）。
 *
 * 引导收集 + 复用 ZCode：轻量文件证据收集（node:fs）→ 语义蒸馏交给注入的
 * generateWorkspaceText 链路 → 落盘单文件 JSON。构建为单当前任务，进度经
 * Emitter 推送；git HEAD 轮询做自动增量（仅重蒸馏受影响表）。
 * 契约见 specs/services/db-board-knowledge.md。
 */
/* eslint-disable max-lines -- 流水线各阶段强共享（walk 收集的证据被蒸馏/落盘/增量三段消费），
   拆分会迫使中间证据结构跨模块导出；与 dbBoardService 豁免口径一致。 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ZCodeWorkspaceGenerateTextParams } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import type { ICredentialService } from "../credential/credential.js";
import type { IDbBoardService } from "../dbBoard/dbBoard.js";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type {
  DbBoardKnowledge,
  DbBoardKnowledgeBuildProgress,
  DbBoardKnowledgeProbeResult,
  DbBoardKnowledgeProfile,
  DbBoardKnowledgeRepoInfo,
  DbBoardKnowledgeRepoSnapshot,
  DbBoardKnowledgeTableCard,
  IDbBoardKnowledgeService,
} from "./dbBoardKnowledge.js";
import {
  classifyEvidenceFile,
  discoverDatasourceUrls,
  discoverNacosFromYml,
  extractApiModuleEntries,
  extractDdlComments,
  extractEntityEvidence,
  extractHtmlTitle,
  extractHttpUrls,
  extractMapperEvidence,
  extractModuleMapEntries,
  extractRouterChineseComments,
  frontendMatchesTable,
  mapChangedFilesToTables,
} from "./dbBoardKnowledgeExtract.js";
import {
  DB_BOARD_KNOWLEDGE_QUERY_SOURCE,
  buildDistillPrompt,
  buildFallbackCard,
  parseTableCardsDraft,
  type DistillTableEvidence,
} from "./dbBoardKnowledgePrompt.js";
import { DbBoardKnowledgeStore } from "./dbBoardKnowledgeStore.js";
import {
  extractJdbcUrlsFromConfig,
  nacosConfigGet,
  nacosConfigList,
  nacosServiceList,
  serviceNameFromDataId,
} from "./nacosClient.js";

const execFileAsync = promisify(execFile);

export const DB_BOARD_KNOWLEDGE_NACOS_PASSWORD_CREDENTIAL_KEY = "db-board-knowledge:nacos-password";

const DISTILL_CHUNK_SIZE = 10;
const DISTILL_MAX_OUTPUT_TOKENS = 4096;
const DISTILL_FALLBACK_MAX_OUTPUT_TOKENS = 1024;
/** 蒸馏 prompt 大 + 4096 token 输出，agent 默认 60s 实测不足（真实构建 7 片超时降级）。 */
const DISTILL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS_RANGE_ERROR = "maxOutputTokens is outside the model option range";
const FILE_READ_LIMIT_BYTES = 256 * 1024;
/** 三仓库全栈项目（后端 Java + PC 多页站 + H5 Vue）实测证据文件约 1900，留余量。 */
const MAX_EVIDENCE_FILES = 4_000;
const WALK_CONCURRENCY = 8;
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  ".spec-workflow",
]);
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

class DbBoardKnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbBoardKnowledgeError";
  }
}

export interface DbBoardKnowledgeServiceOptions {
  credentialService: ICredentialService;
  dbBoardService: IDbBoardService;
  readCurrentModel(): Promise<ZCodeWorkspaceGenerateTextParams["selection"] | null>;
  generateText(params: {
    prompt: string;
    querySource: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    maxOutputTokens?: number;
    /** 放宽 agent 侧 60s 默认超时。 */
    timeoutMs?: number;
  }): Promise<{ text: string }>;
  logger?: ServiceLogger;
  store?: DbBoardKnowledgeStore;
  now?: () => string;
  /** git 增量轮询间隔；0 关闭（测试注入用）。 */
  pollIntervalMs?: number;
}

/** 收集期中间证据（按表聚合）。 */
interface TableEvidenceBucket {
  table: string;
  domain: string;
  entity?: { className: string; classComment: string };
  entityFields: Array<{ column: string; comment: string }>;
  ddlComments: { tableComment?: string; columns: Record<string, string> };
  dbComments: { tableComment?: string; columns: Record<string, string> };
  mapperSql?: string;
  mapperJoins: Array<{ target: string; on: string }>;
  operations: Set<string>;
  /** 前端业务叫法（页面/功能中文名 → 接口路径），按 URL 首段 ↔ 表业务前缀挂载。 */
  frontendPages: string[];
  evidenceFiles: Set<string>;
}

/** 前端证据条目（页面/功能名 + 涉及 URL + 证据文件）。 */
interface FrontendEvidenceEntry {
  name: string;
  urls: string[];
  file: string;
}

export function createDbBoardKnowledgeService(options: DbBoardKnowledgeServiceOptions) {
  const logger = options.logger ?? createServiceLogger("dbBoardKnowledge");
  const store = options.store ?? new DbBoardKnowledgeStore();
  const now = options.now ?? (() => new Date().toISOString());

  const progressEmitter = new Emitter<DbBoardKnowledgeBuildProgress>();
  let buildState: DbBoardKnowledgeBuildProgress = { status: "idle", stage: "done", done: 0, total: 0, detail: "" };
  let buildAbort: AbortController | null = null;
  let lastProgressEmitAt = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 增量与全量互斥（含增量运行中标志）。 */
  let anyBuildRunning = false;

  // --------------------------------------------------------------------------
  // 进度
  // --------------------------------------------------------------------------

  function emitProgress(
    update: Partial<DbBoardKnowledgeBuildProgress> & Pick<DbBoardKnowledgeBuildProgress, "stage" | "detail">,
    options2?: { force?: boolean; terminal?: boolean },
  ): void {
    buildState = { ...buildState, ...update };
    const force = options2?.force ?? false;
    if (!force && Date.now() - lastProgressEmitAt < 300) {
      return;
    }
    lastProgressEmitAt = Date.now();
    progressEmitter.fire(buildState);
  }

  // --------------------------------------------------------------------------
  // 文件系统：仓库探测与证据遍历
  // --------------------------------------------------------------------------

  async function probeRepos(root: string): Promise<DbBoardKnowledgeRepoInfo[]> {
    const rootExists = await stat(root).then(() => true, () => false);
    if (!rootExists) {
      throw new DbBoardKnowledgeError(`目录不存在: ${root}`);
    }
    const candidates: string[] = [];
    if (await stat(join(root, ".git")).then(() => true, () => false)) {
      candidates.push(root);
    } else {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !SKIP_DIR_NAMES.has(entry.name)) {
          const dir = join(root, entry.name);
          if (await stat(join(dir, ".git")).then(() => true, () => false)) {
            candidates.push(dir);
          }
        }
      }
      if (candidates.length === 0) {
        candidates.push(root);
      }
    }
    const repos: DbBoardKnowledgeRepoInfo[] = [];
    for (const path of candidates) {
      const stack = await detectStack(path);
      repos.push({ path, name: path === root ? basename(root) : relative(root, path), stack });
    }
    return repos;
  }

  async function detectStack(repoPath: string): Promise<DbBoardKnowledgeRepoInfo["stack"]> {
    for (const name of ["pom.xml", "build.gradle"] as const) {
      if (await stat(join(repoPath, name)).then(() => true, () => false)) {
        return "maven";
      }
    }
    if (await stat(join(repoPath, "package.json")).then(() => true, () => false)) {
      return "node";
    }
    return "other";
  }

  interface WalkedEvidenceFile {
    kind: ReturnType<typeof classifyEvidenceFile>;
    absPath: string;
    relPath: string;
  }

  async function walkEvidenceFiles(
    repos: readonly DbBoardKnowledgeRepoInfo[],
    root: string,
    signal: AbortSignal,
  ): Promise<WalkedEvidenceFile[]> {
    const collected: WalkedEvidenceFile[] = [];
    let active = 0;
    let nextIndex = 0;
    const queue: string[] = repos.map((repo) => repo.path);
    // 有界并发目录遍历（仿 storage fsWalker：BFS + 并发上限 + 批量让出事件循环）
    await new Promise<void>((resolveWalk, rejectWalk) => {
      const pump = () => {
        if (signal.aborted) {
          rejectWalk(new DbBoardKnowledgeError("已取消"));
          return;
        }
        if (nextIndex >= queue.length && active === 0) {
          resolveWalk();
          return;
        }
        while (active < WALK_CONCURRENCY && nextIndex < queue.length) {
          const dir = queue[nextIndex++]!;
          active += 1;
          void readdir(dir, { withFileTypes: true })
            .then(async (entries) => {
              for (const entry of entries) {
                if (collected.length >= MAX_EVIDENCE_FILES) {
                  break;
                }
                const absPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                  if (!SKIP_DIR_NAMES.has(entry.name) && !entry.name.startsWith(".")) {
                    queue.push(absPath);
                  }
                  continue;
                }
                if (!entry.isFile()) {
                  continue;
                }
                const relPath = relative(root, absPath).replace(/\\/gu, "/");
                const kind = classifyEvidenceFile(relPath);
                if (kind !== "other") {
                  collected.push({ kind, absPath, relPath });
                }
              }
            })
            .catch(() => {
              // 权限/消失目录跳过
            })
            .finally(() => {
              active -= 1;
              pump();
            });
        }
      };
      pump();
    });
    return collected;
  }

  async function readTextCapped(absPath: string): Promise<string | null> {
    try {
      const handle = await readFile(absPath, "utf-8");
      return handle.length > FILE_READ_LIMIT_BYTES ? handle.slice(0, FILE_READ_LIMIT_BYTES) : handle;
    } catch {
      return null;
    }
  }

  /** 表名归一（小写）+ 从 Java 包路径推断业务域。 */
  function domainFromRelPath(relPath: string, fallback: string): string {
    const match = /(?:modules?|com\/[\w]+)\/(\w+)\//u.exec(relPath);
    return match?.[1] ?? fallback;
  }

  interface CollectedEvidence {
    buckets: Map<string, TableEvidenceBucket>;
    discoveredNacosPassword?: string;
    fileCount: number;
  }

  async function collectEvidence(
    repos: readonly DbBoardKnowledgeRepoInfo[],
    root: string,
    signal: AbortSignal,
    onlyTables?: ReadonlySet<string>,
  ): Promise<CollectedEvidence> {
    const files = await walkEvidenceFiles(repos, root, signal);
    const buckets = new Map<string, TableEvidenceBucket>();
    const frontendEntries: FrontendEvidenceEntry[] = [];
    const htmlTitleByRelPath = new Map<string, string>();
    let discoveredNacosPassword: string | undefined;
    const ensureBucket = (table: string, domain: string): TableEvidenceBucket => {
      const key = table.toLowerCase();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          table: key,
          domain,
          entityFields: [],
          ddlComments: { columns: {} },
          dbComments: { columns: {} },
          mapperJoins: [],
          operations: new Set<string>(),
          frontendPages: [],
          evidenceFiles: new Set<string>(),
        };
        buckets.set(key, bucket);
      }
      return bucket;
    };
    const inScope = (table: string) => !onlyTables || onlyTables.has(table.toLowerCase());
    const pageJsPending: Array<{ urls: string[]; file: string }> = [];

    for (const file of files) {
      if (signal.aborted) {
        throw new DbBoardKnowledgeError("已取消");
      }
      if (file.kind === "controller" || file.kind === "service") {
        // 文件名即业务操作线索，不读内容
        const domain = domainFromRelPath(file.relPath, "未分类");
        const opName = basename(file.relPath).replace(/\.(java|xml)$/u, "");
        let ops = controllerOpsByDomain.get(domain);
        if (!ops) {
          ops = new Set<string>();
          controllerOpsByDomain.set(domain, ops);
        }
        ops.add(opName);
        continue;
      }
      const text = await readTextCapped(file.absPath);
      if (!text) {
        continue;
      }
      if (file.kind === "app-yml") {
        const nacos = discoverNacosFromYml(text);
        if (nacos?.password && !discoveredNacosPassword) {
          discoveredNacosPassword = nacos.password;
        }
        continue;
      }
      // ---- 前端证据（PC 多页站 / H5 Vue）----
      if (file.kind === "pc-html") {
        const title = extractHtmlTitle(text);
        if (title) {
          htmlTitleByRelPath.set(file.relPath, title);
        }
        continue;
      }
      if (file.kind === "pc-page-js") {
        const urls = extractHttpUrls(text);
        if (urls.length > 0) {
          pageJsPending.push({ urls, file: file.relPath });
        }
        continue;
      }
      if (file.kind === "h5-vue") {
        const urls = extractHttpUrls(text);
        if (urls.length > 0) {
          frontendEntries.push({
            name: basename(file.relPath, ".vue"),
            urls,
            file: file.relPath,
          });
        }
        continue;
      }
      if (file.kind === "h5-router") {
        for (const entry of extractRouterChineseComments(text)) {
          frontendEntries.push({
            name: entry.comment,
            urls: entry.route ? [entry.route] : [],
            file: file.relPath,
          });
        }
        continue;
      }
      if (file.kind === "h5-api") {
        for (const entry of extractApiModuleEntries(text)) {
          frontendEntries.push({
            name: entry.comment || entry.name,
            urls: entry.url ? [entry.url] : [],
            file: file.relPath,
          });
        }
        continue;
      }
      if (file.kind === "modules-map") {
        for (const entry of extractModuleMapEntries(text)) {
          frontendEntries.push({ name: entry.name, urls: [entry.path], file: file.relPath });
        }
        continue;
      }
      if (file.kind === "entity") {
        const entity = extractEntityEvidence(text);
        if (!entity.tableName) {
          continue;
        }
        const table = entity.tableName.toLowerCase();
        if (!inScope(table)) {
          continue;
        }
        const domain = domainFromRelPath(file.relPath, table.split("_")[0] ?? "未分类");
        const bucket = ensureBucket(table, domain);
        bucket.entity = { className: entity.className, classComment: entity.classComment };
        bucket.entityFields = entity.fields
          .filter((field) => field.comment)
          .map((field) => ({ column: field.column.toLowerCase(), comment: field.comment }));
        bucket.evidenceFiles.add(file.relPath);
        continue;
      }
      if (file.kind === "mapper-xml") {
        const mapper = extractMapperEvidence(text);
        for (const table of mapper.tables) {
          if (!inScope(table)) {
            continue;
          }
          const domain = domainFromRelPath(file.relPath, table.split("_")[0] ?? "未分类");
          const bucket = ensureBucket(table, domain);
          if (!bucket.mapperSql) {
            bucket.mapperSql = mapper.resolvedSql;
          }
          for (const joinInfo of mapper.joins) {
            if (joinInfo.target !== table) {
              bucket.mapperJoins.push(joinInfo);
            }
          }
          for (const statementId of mapper.statementIds) {
            bucket.operations.add(statementId);
          }
          bucket.evidenceFiles.add(file.relPath);
        }
        continue;
      }
      if (file.kind === "ddl") {
        for (const [table, comments] of extractDdlComments(text)) {
          if (!inScope(table)) {
            continue;
          }
          const bucket = ensureBucket(table, table.split("_")[0] ?? "未分类");
          bucket.ddlComments = {
            ...comments,
            columns: { ...bucket.ddlComments.columns, ...comments.columns },
          };
          if (comments.tableComment && !bucket.ddlComments.tableComment) {
            bucket.ddlComments.tableComment = comments.tableComment;
          }
          bucket.evidenceFiles.add(file.relPath);
        }
      }
    }
    // PC 页面逻辑与同名 HTML 标题配对（views/**.html ↔ assets/js-v/**.js），产出"中文页面名 → 接口"。
    for (const pending of pageJsPending) {
      const htmlRel = pending.file.replace("assets/js-v/", "views/").replace(/\.js$/u, ".html");
      const title = htmlTitleByRelPath.get(htmlRel);
      frontendEntries.push({
        name: title ?? basename(pending.file, ".js"),
        urls: pending.urls,
        file: pending.file,
      });
    }
    // 前端业务叫法挂载：URL 首段 ↔ 表业务前缀（oa_doc ↔ doc/*、oa_car_apply ↔ car/*）。
    for (const bucket of buckets.values()) {
      const matched = frontendEntries
        .filter((entry) => entry.urls.length > 0 && frontendMatchesTable(entry.urls, bucket.table))
        .slice(0, 12);
      bucket.frontendPages = matched.map((entry) =>
        `${entry.name} → ${entry.urls.slice(0, 3).join(", ")}`,
      );
      for (const entry of matched) {
        bucket.evidenceFiles.add(entry.file);
      }
    }
    return { buckets, discoveredNacosPassword, fileCount: files.length };
  }

  /** Controller/Service 操作名按域暂存（蒸馏 prompt 用）。 */
  const controllerOpsByDomain = new Map<string, Set<string>>();
  function opsForDomain(domain: string): string[] {
    return [...(controllerOpsByDomain.get(domain) ?? [])].slice(0, 20);
  }

  // --------------------------------------------------------------------------
  // DB 注释与 Nacos
  // --------------------------------------------------------------------------

  /** 目标库实际存在的表名集合（小写）；知识构建以此过滤"代码里有但库里没有"的表（如新 OA 系统的表在另一个库）。 */
  let existingTableNames: ReadonlySet<string> | null = null;

  async function collectDbComments(
    buckets: Map<string, TableEvidenceBucket>,
    extraTables: ReadonlySet<string>,
  ): Promise<void> {
    emitProgress({ stage: "db-comments", detail: "拉取数据库表/列注释…", done: 0, total: 0 });
    let tablesMeta: Awaited<ReturnType<IDbBoardService["listTables"]>> = [];
    try {
      tablesMeta = await options.dbBoardService.listTables();
    } catch {
      existingTableNames = null;
      return;
    }
    existingTableNames = new Set(tablesMeta.map((meta) => meta.name.toLowerCase()));
    for (const meta of tablesMeta) {
      const key = meta.name.toLowerCase();
      const isBucket = buckets.has(key);
      if (!isBucket && !extraTables.has(key)) {
        continue;
      }
      if (meta.comment && !isBucket) {
        // 无代码证据但有表注释的表：生成轻量 db-comment 卡
        const bucket = buckets.get(key) ?? {
          table: key,
          domain: meta.comment.split(/[--／/]/u)[0]?.trim() || key.split("_")[0] || "未分类",
          entityFields: [],
          ddlComments: { columns: {} },
          dbComments: { tableComment: "", columns: {} },
          mapperJoins: [],
          operations: new Set<string>(),
          frontendPages: [],
          evidenceFiles: new Set<string>(),
        };
        bucket.dbComments.tableComment = meta.comment;
        buckets.set(key, bucket);
        continue;
      }
      if (isBucket && meta.comment) {
        buckets.get(key)!.dbComments.tableComment = meta.comment;
      }
    }
    // 列注释：仅对有 bucket 的表拉取（catalog 有 30s 缓存，成本可控）
    let done = 0;
    for (const bucket of buckets.values()) {
      const meta = tablesMeta.find((item) => item.name.toLowerCase() === bucket.table);
      if (!meta) {
        continue;
      }
      try {
        const columns = await options.dbBoardService.getTableColumns(meta.schema, meta.name);
        for (const column of columns) {
          if (column.comment) {
            bucket.dbComments.columns[column.name.toLowerCase()] = column.comment;
          }
        }
      } catch {
        // 单表失败跳过
      }
      done += 1;
      emitProgress({ stage: "db-comments", detail: `数据库注释 ${done}/${buckets.size}`, done, total: buckets.size });
    }
  }

  async function collectNacos(
    profile: DbBoardKnowledgeProfile,
    discoveredPassword?: string,
  ): Promise<Pick<DbBoardKnowledge["stats"], "nacosServices" | "datasourceMapping">> {
    if (!profile.nacos?.serverAddr) {
      return {};
    }
    emitProgress({ stage: "nacos", detail: "拉取 Nacos 服务清单与配置…", done: 0, total: 0 });
    let credentialPassword: string | null = null;
    try {
      credentialPassword = await options.credentialService.load(
        DB_BOARD_KNOWLEDGE_NACOS_PASSWORD_CREDENTIAL_KEY,
      );
    } catch {
      credentialPassword = null;
    }
    const config = {
      serverAddr: profile.nacos.serverAddr,
      ...(profile.nacos.namespace ? { namespace: profile.nacos.namespace } : {}),
      ...(profile.nacos.username ? { username: profile.nacos.username } : {}),
      password: profile.nacos.password ?? credentialPassword ?? discoveredPassword,
    };
    const services = (await nacosServiceList(config)) ?? [];
    const mapping: Array<{ service: string; url: string }> = [];
    const configs = await nacosConfigList(config);
    if (configs) {
      for (const info of configs.slice(0, 50)) {
        const content = await nacosConfigGet(config, info.dataId, info.group);
        if (!content) {
          continue;
        }
        for (const url of extractJdbcUrlsFromConfig(content)) {
          mapping.push({ service: serviceNameFromDataId(info.dataId), url });
        }
      }
    }
    if (services.length === 0 && mapping.length === 0) {
      logger.warn(undefined, "Nacos 拉取失败，构建降级跳过该阶段", {
        serverAddr: profile.nacos.serverAddr,
      });
      return {};
    }
    return { nacosServices: services, datasourceMapping: mapping };
  }

  // --------------------------------------------------------------------------
  // 蒸馏与落盘
  // --------------------------------------------------------------------------

  async function completeText(
    prompt: string,
    querySource: string,
    selection: ZCodeWorkspaceGenerateTextParams["selection"],
    budget: number,
  ): Promise<string> {
    try {
      const result = await options.generateText({
        prompt,
        querySource,
        selection,
        maxOutputTokens: budget,
        timeoutMs: DISTILL_TIMEOUT_MS,
      });
      return result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (budget > DISTILL_FALLBACK_MAX_OUTPUT_TOKENS && message.includes(MAX_OUTPUT_TOKENS_RANGE_ERROR)) {
        const result = await options.generateText({
          prompt,
          querySource,
          selection,
          maxOutputTokens: DISTILL_FALLBACK_MAX_OUTPUT_TOKENS,
          timeoutMs: DISTILL_TIMEOUT_MS,
        });
        return result.text;
      }
      throw error;
    }
  }

  function toDistillEvidence(bucket: TableEvidenceBucket): DistillTableEvidence {
    return {
      table: bucket.table,
      domain: bucket.domain,
      ...(bucket.entity ? { entity: bucket.entity } : {}),
      entityFields: bucket.entityFields,
      ddlComments: bucket.ddlComments,
      dbComments: bucket.dbComments,
      ...(bucket.mapperSql ? { mapperSql: bucket.mapperSql } : {}),
      operations: [...bucket.operations, ...opsForDomain(bucket.domain)],
      ...(bucket.frontendPages.length > 0 ? { frontendPages: bucket.frontendPages } : {}),
    };
  }

  async function distillBuckets(
    buckets: Map<string, TableEvidenceBucket>,
    signal: AbortSignal,
  ): Promise<Map<string, DbBoardKnowledgeTableCard>> {
    const selection = await resolveCurrentModel();
    const entries = [...buckets.values()];
    const chunks: TableEvidenceBucket[][] = [];
    // 按域分片，域内每 DISTILL_CHUNK_SIZE 张一批
    const byDomain = new Map<string, TableEvidenceBucket[]>();
    for (const bucket of entries) {
      const list = byDomain.get(bucket.domain) ?? [];
      list.push(bucket);
      byDomain.set(bucket.domain, list);
    }
    for (const list of byDomain.values()) {
      for (let index = 0; index < list.length; index += DISTILL_CHUNK_SIZE) {
        chunks.push(list.slice(index, index + DISTILL_CHUNK_SIZE));
      }
    }
    const cards = new Map<string, DbBoardKnowledgeTableCard>();
    let done = 0;
    for (const chunk of chunks) {
      if (signal.aborted) {
        throw new DbBoardKnowledgeError("已取消");
      }
      // 无代码证据的表（仅数据库注释）直接出降级卡，不消耗 LLM——
      // 真实构建实测这类表约 90 张，占蒸馏片数一半以上且信息增量低。
      const distillable = chunk.filter(
        (bucket) =>
          bucket.entity !== undefined ||
          bucket.mapperSql !== undefined ||
          bucket.entityFields.length > 0 ||
          Object.keys(bucket.ddlComments.columns).length > 0,
      );
      for (const bucket of chunk) {
        if (!distillable.includes(bucket) && !cards.has(bucket.table)) {
          cards.set(bucket.table, buildFallbackCard(toDistillEvidence(bucket), [...bucket.evidenceFiles]));
        }
      }
      if (distillable.length === 0) {
        done += chunk.length;
        emitProgress({
          stage: "distill",
          detail: `业务蒸馏 ${done}/${entries.length} 张表`,
          done,
          total: entries.length,
        });
        continue;
      }
      const prompt = buildDistillPrompt(distillable.map(toDistillEvidence));
      let distilled = false;
      for (let attempt = 0; attempt < 2 && !distilled; attempt += 1) {
        try {
          const raw = await completeText(
            prompt,
            DB_BOARD_KNOWLEDGE_QUERY_SOURCE,
            selection,
            DISTILL_MAX_OUTPUT_TOKENS,
          );
          const parsed = parseTableCardsDraft(raw);
          if (parsed.ok) {
            for (const card of parsed.cards) {
              const bucket = distillable.find((item) => item.table === card.table.toLowerCase());
              if (!bucket) {
                continue;
              }
              cards.set(bucket.table, {
                table: bucket.table,
                domain: card.domain || bucket.domain,
                purpose: card.purpose,
                keyColumns: card.keyColumns,
                relations: card.relations,
                ...(card.notes ? { notes: card.notes } : {}),
                evidenceFiles: [...bucket.evidenceFiles],
                source: "distilled",
              });
              distilled = true;
            }
          }
        } catch (error) {
          logger.warn(undefined, "知识蒸馏调用失败（重试/降级）", {
            tables: distillable.map((item) => item.table).join(","),
            attempt,
            error: error instanceof Error ? error.message.slice(0, 120) : String(error),
          });
        }
      }
      // 降级：纯抽取卡
      for (const bucket of distillable) {
        if (!cards.has(bucket.table)) {
          cards.set(bucket.table, buildFallbackCard(toDistillEvidence(bucket), [...bucket.evidenceFiles]));
        }
      }
      done += chunk.length;
      emitProgress({
        stage: "distill",
        detail: `业务蒸馏 ${done}/${entries.length} 张表`,
        done,
        total: entries.length,
      });
    }
    return cards;
  }

  async function resolveCurrentModel(): Promise<ZCodeWorkspaceGenerateTextParams["selection"]> {
    const current = await options.readCurrentModel();
    const providerId = current?.providerId?.trim();
    const modelId = current?.modelId?.trim();
    if (!providerId || !modelId) {
      throw new DbBoardKnowledgeError("未读取到当前模型，请先在模型选择中配置模型。");
    }
    return current!;
  }

  /** 手动改卡后重算域分组与统计（保持与构建产物同构）。 */
  function recomputeKnowledge(knowledge: DbBoardKnowledge): DbBoardKnowledge {
    const domains: Record<string, string[]> = {};
    for (const card of Object.values(knowledge.tables)) {
      (domains[card.domain] ??= []).push(card.table);
    }
    let distilled = 0;
    let extracted = 0;
    let dbCommentOnly = 0;
    for (const card of Object.values(knowledge.tables)) {
      if (card.source === "distilled") distilled += 1;
      else if (card.source === "extracted") extracted += 1;
      else dbCommentOnly += 1;
    }
    return {
      ...knowledge,
      domains,
      stats: {
        ...knowledge.stats,
        tableCount: Object.keys(knowledge.tables).length,
        domainCount: Object.keys(domains).length,
        distilled,
        extracted,
        dbCommentOnly,
      },
    };
  }

  function buildKnowledge(
    cards: Map<string, DbBoardKnowledgeTableCard>,
    repoSnapshots: DbBoardKnowledgeRepoSnapshot[],
    nacosStats: Pick<DbBoardKnowledge["stats"], "nacosServices" | "datasourceMapping">,
    previous?: DbBoardKnowledge | null,
  ): DbBoardKnowledge {
    // 存在性过滤：代码证据可能包含其他库的表（如新 OA 系统在独立数据库），
    // 生成时模型选中它们会产生必然失败的 SQL——只保留目标库真实存在的表。
    let dropped = 0;
    if (existingTableNames) {
      for (const table of cards.keys()) {
        if (!existingTableNames.has(table)) {
          cards.delete(table);
          dropped += 1;
        }
      }
      if (dropped > 0) {
        logger.info(undefined, "知识库过滤掉目标库不存在的表", { dropped });
      }
    }
    const domains: Record<string, string[]> = {};
    for (const card of cards.values()) {
      const list = domains[card.domain] ?? [];
      list.push(card.table);
      domains[card.domain] = list;
    }
    let distilled = 0;
    let extracted = 0;
    let dbCommentOnly = 0;
    for (const card of cards.values()) {
      if (card.source === "distilled") distilled += 1;
      else if (card.source === "extracted") extracted += 1;
      else dbCommentOnly += 1;
    }
    return {
      version: 1,
      builtAt: now(),
      domains,
      tables: Object.fromEntries(cards),
      repoSnapshots,
      stats: {
        tableCount: cards.size,
        domainCount: Object.keys(domains).length,
        distilled,
        extracted,
        dbCommentOnly,
        ...nacosStats,
        ...(previous?.stats.lastIncrementalAt ? { lastIncrementalAt: previous.stats.lastIncrementalAt } : {}),
      },
    };
  }

  // --------------------------------------------------------------------------
  // 构建（全量 / 增量共用骨架）
  // --------------------------------------------------------------------------

  async function runBuild(affectedTables?: ReadonlySet<string>): Promise<void> {
    const doc = await store.load();
    const profile = doc.profile;
    if (!profile?.projectRoot) {
      throw new DbBoardKnowledgeError("尚未注册项目根目录，请先保存知识库配置。");
    }
    const root = resolve(profile.projectRoot);
    const signal = buildAbort!.signal;
    controllerOpsByDomain.clear();

    emitProgress(
      { stage: "probe", detail: "探测 git 仓库与技术栈…", done: 0, total: 0, status: "running", startedAt: now(), ...(affectedTables ? { incrementalTables: [...affectedTables] } : { incrementalTables: undefined }) },
      { force: true },
    );
    const repos = await probeRepos(root);
    const repoSnapshots: DbBoardKnowledgeRepoSnapshot[] = [];
    for (const repo of repos) {
      const head = await gitHead(repo.path);
      repoSnapshots.push({ path: repo.name, head });
    }

    emitProgress({ stage: "scan", detail: "扫描代码证据…", done: 0, total: 0 });
    const collected = await collectEvidence(repos, root, signal, affectedTables);
    emitProgress({
      stage: "scan",
      detail: `证据收集完成：${collected.fileCount} 个证据文件`,
      done: 1,
      total: 1,
    });

    // 增量模式：保留未受影响表的原卡片
    const previousKnowledge = doc.knowledge ?? null;
    const carryOverCards = new Map<string, DbBoardKnowledgeTableCard>();
    if (affectedTables && previousKnowledge) {
      for (const [table, card] of Object.entries(previousKnowledge.tables)) {
        if (!affectedTables.has(table)) {
          carryOverCards.set(table, card);
        }
      }
    }

    const extraTables = new Set<string>();
    if (!affectedTables && previousKnowledge) {
      // 全量构建也保留此前由 db-comment 补充的表线索（重新评估）
      for (const table of Object.keys(previousKnowledge.tables)) {
        extraTables.add(table);
      }
    }
    await collectDbComments(collected.buckets, extraTables);

    const nacosStats = await collectNacos(profile, collected.discoveredNacosPassword);

    emitProgress({ stage: "distill", detail: "业务蒸馏…", done: 0, total: collected.buckets.size });
    const distilledCards = await distillBuckets(collected.buckets, signal);

    emitProgress({ stage: "persist", detail: "归并落盘知识库…", done: 0, total: 0 });
    const merged = new Map<string, DbBoardKnowledgeTableCard>([...carryOverCards, ...distilledCards]);
    const knowledge = buildKnowledge(merged, repoSnapshots, nacosStats, previousKnowledge);
    await store.saveKnowledge(knowledge);
    logger.info(undefined, "知识库构建完成", {
      tables: knowledge.stats.tableCount,
      domains: knowledge.stats.domainCount,
      distilled: knowledge.stats.distilled,
      incremental: Boolean(affectedTables),
    });
    emitProgress(
      {
        stage: "done",
        status: "completed",
        detail: `构建完成：${knowledge.stats.tableCount} 张表 / ${knowledge.stats.domainCount} 个业务域`,
        done: 1,
        total: 1,
        finishedAt: now(),
      },
      { force: true, terminal: true },
    );
  }

  async function runBuildGuarded(affectedTables?: ReadonlySet<string>): Promise<void> {
    if (anyBuildRunning) {
      throw new DbBoardKnowledgeError("已有构建在进行中。");
    }
    anyBuildRunning = true;
    buildAbort = new AbortController();
    try {
      await runBuild(affectedTables);
    } catch (error) {
      const cancelled = buildAbort.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      emitProgress(
        {
          stage: "done",
          status: cancelled ? "cancelled" : "failed",
          detail: cancelled ? "已取消" : `构建失败：${message.slice(0, 200)}`,
          error: cancelled ? undefined : message.slice(0, 300),
          finishedAt: now(),
        },
        { force: true },
      );
      if (!cancelled) {
        logger.error(undefined, "知识库构建失败", { error: message.slice(0, 300) });
      }
    } finally {
      anyBuildRunning = false;
      buildAbort = null;
    }
  }

  // --------------------------------------------------------------------------
  // git 增量轮询
  // --------------------------------------------------------------------------

  async function gitHead(repoPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
        timeout: 10_000,
        windowsHide: true,
      });
      return stdout.trim();
    } catch {
      return "unknown";
    }
  }

  async function gitChangedFiles(repoPath: string, fromHead: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", fromHead, "HEAD"], {
        cwd: repoPath,
        timeout: 15_000,
        windowsHide: true,
      });
      return stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function evidenceIndexOf(knowledge: DbBoardKnowledge): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const card of Object.values(knowledge.tables)) {
      index.set(card.table, card.evidenceFiles);
    }
    return index;
  }

  async function pollIncremental(): Promise<void> {
    if (anyBuildRunning) {
      return;
    }
    const doc = await store.load();
    if (!doc.profile?.projectRoot || !doc.knowledge) {
      return;
    }
    const root = resolve(doc.profile.projectRoot);
    try {
      const repos = await probeRepos(root);
      const changedFiles: string[] = [];
      let changed = false;
      const nextSnapshots: DbBoardKnowledgeRepoSnapshot[] = [];
      for (const repo of repos) {
        const head = await gitHead(repo.path);
        const previous = doc.knowledge.repoSnapshots.find((snapshot) => snapshot.path === repo.name);
        nextSnapshots.push({ path: repo.name, head });
        if (!previous || previous.head !== head) {
          changed = true;
          if (previous && previous.head !== "unknown") {
            changedFiles.push(
              ...(await gitChangedFiles(repo.path, previous.head)).map((file) =>
                join(repo.name, file).replace(/\\/gu, "/"),
              ),
            );
          }
        }
      }
      if (!changed) {
        return;
      }
      const affected = mapChangedFilesToTables(changedFiles, evidenceIndexOf(doc.knowledge));
      if (affected.length > 0) {
        logger.info(undefined, "检测到 git 变更，开始增量蒸馏", {
          repos: nextSnapshots.map((snapshot) => `${snapshot.path}@${snapshot.head.slice(0, 8)}`).join(","),
          affectedTables: affected.join(","),
        });
        await runBuildGuarded(new Set(affected.map((table) => table.toLowerCase())));
        const updated = await store.load();
        if (updated.knowledge) {
          await store.saveKnowledge({
            ...updated.knowledge,
            repoSnapshots: nextSnapshots,
            stats: { ...updated.knowledge.stats, lastIncrementalAt: now() },
          });
        }
      } else {
        // 无受影响表：只更新快照
        await store.saveKnowledge({ ...doc.knowledge, repoSnapshots: nextSnapshots });
      }
    } catch (error) {
      logger.warn(undefined, "增量轮询失败（下轮重试）", {
        error: error instanceof Error ? error.message.slice(0, 120) : String(error),
      });
    }
  }

  function startPolling(intervalMs: number): void {
    if (intervalMs <= 0 || pollTimer) {
      return;
    }
    pollTimer = setInterval(() => {
      void pollIncremental();
    }, intervalMs);
    pollTimer.unref?.();
  }

  // --------------------------------------------------------------------------
  // 服务面
  // --------------------------------------------------------------------------

  const service: IDbBoardKnowledgeService = {
    async getProfile() {
      const doc = await store.load();
      return doc.profile ?? null;
    },

    async saveProfile(profile: DbBoardKnowledgeProfile, nacosPassword?: string) {
      if (!profile.projectRoot?.trim()) {
        throw new DbBoardKnowledgeError("项目根目录不能为空。");
      }
      await store.saveProfile({ ...profile, projectRoot: resolve(profile.projectRoot.trim()) });
      if (typeof nacosPassword === "string" && nacosPassword.trim()) {
        await options.credentialService.save(
          DB_BOARD_KNOWLEDGE_NACOS_PASSWORD_CREDENTIAL_KEY,
          nacosPassword.trim(),
        );
      }
      // 项目档案绑定连接：保存即激活为看板当前连接（多项目/多环境切换入口）
      if (profile.dbBinding?.connectionId) {
        await options.dbBoardService.setActiveConnection(profile.dbBinding.connectionId);
      }
      logger.info(undefined, "知识库项目配置已保存", { projectRoot: profile.projectRoot });
    },

    async probeProject(root: string): Promise<DbBoardKnowledgeProbeResult> {
      const resolved = resolve(root.trim());
      try {
        const repos = await probeRepos(resolved);
        const result: DbBoardKnowledgeProbeResult = { root: resolved, repos };
        // 只读配置线索（不触发全量 walk）：仓库根 + 一级模块目录的 resources 下的常见配置名。
        const candidateDirs: string[] = [];
        for (const repo of repos) {
          candidateDirs.push(join(repo.path, "src/main/resources"));
          try {
            for (const entry of await readdir(repo.path, { withFileTypes: true })) {
              if (entry.isDirectory() && !SKIP_DIR_NAMES.has(entry.name) && candidateDirs.length < 24) {
                candidateDirs.push(join(repo.path, entry.name, "src/main/resources"));
              }
            }
          } catch {
            // 仓库根读取失败跳过
          }
        }
        const ymlNames = [
          "application.yml",
          "application-dev.yml",
          "application-local.yml",
          "bootstrap.yml",
        ] as const;
        for (const dir of candidateDirs) {
          for (const name of ymlNames) {
            const text = await readTextCapped(join(dir, name));
            if (!text) {
              continue;
            }
            const nacos = discoverNacosFromYml(text);
            if (nacos && !result.discoveredNacos) {
              result.discoveredNacos = {
                serverAddr: nacos.serverAddr,
                ...(nacos.namespace ? { namespace: nacos.namespace } : {}),
                ...(nacos.username ? { username: nacos.username } : {}),
                ...(nacos.password ? { password: "***" } : {}),
              };
            }
            const urls = discoverDatasourceUrls(text);
            if (urls.length > 0) {
              result.discoveredDatasourceUrls = [...(result.discoveredDatasourceUrls ?? []), ...urls];
            }
          }
        }
        return result;
      } catch (error) {
        return {
          root: resolved,
          repos: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async startBuild() {
      // 立即返回：构建可能持续数十分钟，长挂 RPC promise 会被连接层掐断；
      // 进度/终态一律经 onBuildProgress 事件与 getBuildState 查询（UI 已按此消费）。
      if (anyBuildRunning) {
        throw new DbBoardKnowledgeError("已有构建在进行中。");
      }
      void runBuildGuarded();
    },

    async cancelBuild() {
      buildAbort?.abort();
    },

    async getBuildState() {
      return buildState;
    },

    onBuildProgress: progressEmitter.event,

    async getKnowledge() {
      const doc = await store.load();
      return doc.knowledge ?? null;
    },

    async saveTableCard(card) {
      const doc = await store.load();
      if (!doc.knowledge) {
        throw new DbBoardKnowledgeError("尚未构建知识库，请先完成一次构建。");
      }
      const knowledge = doc.knowledge;
      knowledge.tables[card.table.toLowerCase()] = {
        ...card,
        table: card.table.toLowerCase(),
      };
      await store.saveKnowledge(recomputeKnowledge(knowledge));
      logger.info(undefined, "知识卡已手动保存", { table: card.table });
    },

    async deleteTableCard(table) {
      const doc = await store.load();
      if (!doc.knowledge) {
        return;
      }
      const knowledge = doc.knowledge;
      delete knowledge.tables[table.toLowerCase()];
      await store.saveKnowledge(recomputeKnowledge(knowledge));
      logger.info(undefined, "知识卡已手动删除", { table });
    },

    async distillTableCard(input) {
      const tableKey = input.table.trim().toLowerCase();
      if (!tableKey) {
        throw new DbBoardKnowledgeError("表名不能为空。");
      }
      emitProgress(
        { stage: "distill", status: "running", detail: `手动蒸馏 ${tableKey}…`, done: 0, total: 1, startedAt: now() },
        { force: true },
      );
      try {
        // 证据：DB 表注释 + 列注释（看板连接）+ 既有卡片（若有）的蒸馏成果
        const doc = await store.load();
        const existing = doc.knowledge?.tables[tableKey] ?? null;
        const columnsMeta = await options.dbBoardService.getTableColumns(input.schema, input.table);
        let dbTableComment = "";
        try {
          const tablesMeta = await options.dbBoardService.listTables();
          dbTableComment = tablesMeta.find((meta) => meta.name.toLowerCase() === tableKey)?.comment ?? "";
        } catch {
          dbTableComment = "";
        }
        const evidence: DistillTableEvidence = {
          table: tableKey,
          domain:
            existing?.domain ||
            dbTableComment.split(/[--／/]/u)[0]?.trim() ||
            tableKey.split("_")[0] ||
            "未分类",
          entityFields: (existing?.keyColumns ?? []).map((column) => ({
            column: column.name.toLowerCase(),
            comment: column.meaning,
          })),
          ddlComments: { columns: {} },
          dbComments: {
            // 既有卡的 purpose 是更强的口径证据，优先于表注释
            tableComment: existing?.purpose || dbTableComment,
            columns: Object.fromEntries(
              columnsMeta
                .filter((column) => column.comment)
                .map((column) => [column.name.toLowerCase(), column.comment!]),
            ),
          },
          ...(existing?.relations?.length
            ? {
                mapperSql: existing.relations
                  .map((relation) => `LEFT JOIN ${relation.target} ON ${relation.on ?? "?"}`)
                  .join("\n"),
              }
            : {}),
          operations: [],
        };
        const selection = await resolveCurrentModel();
        const raw = await completeText(
          buildDistillPrompt([evidence]),
          DB_BOARD_KNOWLEDGE_QUERY_SOURCE,
          selection,
          DISTILL_MAX_OUTPUT_TOKENS,
        );
        const parsed = parseTableCardsDraft(raw);
        if (!parsed.ok || parsed.cards.length === 0) {
          throw new DbBoardKnowledgeError(`蒸馏输出不可用：${parsed.ok ? "空结果" : parsed.reason}`);
        }
        const draft = parsed.cards[0]!;
        emitProgress(
          { stage: "done", status: "completed", detail: `手动蒸馏 ${tableKey} 完成`, done: 1, total: 1, finishedAt: now() },
          { force: true },
        );
        return {
          table: tableKey,
          domain: draft.domain || evidence.domain,
          purpose: draft.purpose,
          keyColumns: draft.keyColumns,
          relations: draft.relations,
          ...(draft.notes ? { notes: draft.notes } : {}),
          evidenceFiles: existing?.evidenceFiles ?? [],
          source: "distilled",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitProgress(
          { stage: "done", status: "failed", detail: `手动蒸馏失败：${message.slice(0, 160)}`, error: message.slice(0, 300), finishedAt: now() },
          { force: true },
        );
        throw error;
      }
    },

    async deleteKnowledge() {
      await store.deleteKnowledge();
      logger.info(undefined, "知识库已删除");
    },
  };

  startPolling(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  return service;
}
