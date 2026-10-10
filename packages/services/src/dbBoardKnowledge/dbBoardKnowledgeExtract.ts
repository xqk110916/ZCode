/**
 * 项目证据抽取（纯函数，文本级正则/切片，无 IO；单元测试覆盖）。
 *
 * 刻意不做语法级解析（依托后续 LLM 理解），只保证三类高价值信号可靠抽出：
 * - 实体：@TableName 表名 + 字段中文 javadoc（MyBatis-Plus 风格）。
 * - Mapper XML：include 解析后的 SQL 文本 → 表引用与 join 关系。
 * - DDL：MySQL 内联 COMMENT 与 PG/Kingbase `COMMENT ON` 两种方言的表/列注释。
 */

// ============================================================================
// 实体（Java）
// ============================================================================

export interface EntityFieldEvidence {
  javaField: string;
  /** @TableId/@TableField 显式列名；缺省按驼峰转下划线。 */
  column: string;
  comment: string;
}

export interface EntityEvidence {
  className: string;
  tableName: string | null;
  /** 类级 javadoc（表用途线索）。 */
  classComment: string;
  fields: EntityFieldEvidence[];
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

/** 抽取 MyBatis-Plus 实体的表名与字段中文注释。 */
export function extractEntityEvidence(javaSource: string): EntityEvidence {
  const lines = javaSource.split(/\r?\n/u);
  const classNameMatch = /(?:class|interface|enum)\s+(\w+)/u.exec(javaSource);
  const className = classNameMatch?.[1] ?? "";
  const tableNameMatch = /@TableName\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/u.exec(javaSource);

  const fields: EntityFieldEvidence[] = [];
  let classComment = "";
  let pendingComment: string[] = [];
  let pendingColumn: string | null = null;
  let inClassHeader = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // javadoc / 行注释累积
    if (line.startsWith("/**") || line.startsWith("*") || line.startsWith("//")) {
      const text = line
        .replace(/^\/\*\*+/u, "")
        .replace(/^\*\/?/u, "")
        .replace(/^\/\/+/u, "")
        .trim();
      if (text) {
        pendingComment.push(text);
      }
      continue;
    }
    // 注解列名
    const columnMatch = /@(?:TableId|TableField)\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/u.exec(line);
    if (columnMatch) {
      pendingColumn = columnMatch[1]!;
      continue;
    }
    // 字段声明
    const fieldMatch = /private\s+(?:static\s+final\s+|final\s+|static\s+)?[\w.<>[\],\s?]+?\s(\w+)\s*(?:=[^;]*)?;/u.exec(
      line,
    );
    if (fieldMatch) {
      const javaField = fieldMatch[1]!;
      const comment = pendingComment.join(" ").trim();
      if (comment || pendingColumn) {
        fields.push({
          javaField,
          column: pendingColumn ?? camelToSnake(javaField),
          comment,
        });
      }
      pendingComment = [];
      pendingColumn = null;
      continue;
    }
    if (line.startsWith("public class") || line.startsWith("public abstract class")) {
      if (inClassHeader) {
        classComment = pendingComment.join(" ").trim();
        inClassHeader = false;
      }
      pendingComment = [];
      continue;
    }
    if (line === "" || line.startsWith("@") || line.startsWith("package") || line.startsWith("import")) {
      if (line === "") {
        pendingComment = [];
      }
      continue;
    }
  }
  return {
    className,
    tableName: tableNameMatch?.[1] ?? null,
    classComment,
    fields,
  };
}

// ============================================================================
// Mapper XML
// ============================================================================

export interface MapperEvidence {
  /** include 解析后 SQL 中出现的表名（小写去引号）。 */
  tables: string[];
  /** join 关系（目标表 + ON 条件文本）。 */
  joins: Array<{ target: string; on: string }>;
  /** 语句 id 清单（业务操作名线索）。 */
  statementIds: string[];
  /** 解析 include 后的 SQL 文本（截断）。 */
  resolvedSql: string;
}

/** 限定名模式：`PUBLIC`、`oa_t`、`"PUBLIC"."t"`（引号段与点分隔都支持）。 */
const QUALIFIED_NAME = String.raw`(?:[\w$]+|"[^"]*")(?:\.(?:[\w$]+|"[^"]*"))*`;
const SQL_TABLE_RE = new RegExp(
  String.raw`\b(?:from|join|update|into)\s+(` + QUALIFIED_NAME + String.raw`)`,
  "giu",
);
const JOIN_RE = new RegExp(
  String.raw`\bjoin\s+(` +
    QUALIFIED_NAME +
    String.raw`)\s+(?:as\s+)?\w*\s*\s?on\s+([^\s(][^)]*?)(?=\s(?:left|right|full|inner|cross|join|where|group|order|union|having|limit|offset)\b|[;<]|$)`,
  "giu",
);
const IDENT_CLEAN_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/u;

function normalizeTableName(raw: string): string | null {
  const name = raw.replace(/"/gu, "").toLowerCase().split(".").pop() ?? "";
  return IDENT_CLEAN_RE.test(name) ? name : null;
}

/** 抽取 Mapper XML 的表引用与 join 关系（解析 <include refid> 与 <sql> 片段）。 */
export function extractMapperEvidence(xmlSource: string): MapperEvidence {
  // <sql id> 片段表 + <include refid> 替换（自闭合与开闭标签两种形式都支持，
  // 遗留的 </include> 由后续标签清洗移除）。
  const fragmentMap = new Map<string, string>();
  const sqlBlockRe = /<sql\s+id="([^"]+)"\s*>([\s\S]*?)<\/sql>/giu;
  for (const match of xmlSource.matchAll(sqlBlockRe)) {
    fragmentMap.set(match[1]!, match[2] ?? "");
  }
  let resolved = xmlSource.replace(
    /<include\s+refid="([^"]+)"[^>]*\/?>/giu,
    (_all, refId: string) => fragmentMap.get(refId) ?? "",
  );
  // 去掉 XML 标签与动态指令，保留 SQL 文本
  resolved = resolved
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<resultMap[\s\S]*?<\/resultMap>/giu, " ")
    .replace(/<sql[\s\S]*?<\/sql>/giu, " ")
    .replace(/<[a-zA-Z!??][^>]*>/gu, " ")
    .replace(/#\{[^}]*\}/gu, "?")
    .replace(/\$\{[^}]*\}/gu, "?")
    .replace(/\s+/gu, " ");
  const resolvedSql = resolved.slice(0, 8_000);

  const tables = new Set<string>();
  for (const match of resolved.matchAll(SQL_TABLE_RE)) {
    const name = normalizeTableName(match[1]!);
    if (name) {
      tables.add(name);
    }
  }
  const joins: Array<{ target: string; on: string }> = [];
  for (const match of resolved.matchAll(JOIN_RE)) {
    const target = normalizeTableName(match[1]!);
    if (!target) continue;
    joins.push({ target, on: (match[2] ?? "").trim().slice(0, 120) });
  }
  const statementIds: string[] = [];
  for (const match of xmlSource.matchAll(/<(?:select|update|insert|delete)\s+id="([^"]+)"/giu)) {
    statementIds.push(match[1]!);
  }
  return { tables: [...tables], joins, statementIds: statementIds.slice(0, 30), resolvedSql };
}

// ============================================================================
// DDL（MySQL 内联 COMMENT 与 PG/Kingbase COMMENT ON 双方言）
// ============================================================================

export interface DdlTableComments {
  tableComment?: string;
  columns: Record<string, string>;
}

/** 抽取 DDL 中的表/列注释（兼容 MySQL 内联 COMMENT 与 `COMMENT ON` 语句）。 */
export function extractDdlComments(sqlSource: string): Map<string, DdlTableComments> {
  const result = new Map<string, DdlTableComments>();
  const ensure = (table: string): DdlTableComments => {
    const key = table.toLowerCase();
    let entry = result.get(key);
    if (!entry) {
      entry = { columns: {} };
      result.set(key, entry);
    }
    return entry;
  };

  // COMMENT ON TABLE/COLUMN（PG/Kingbase 方言，限定名可带引号段）
  const commentOnTableRe = new RegExp(
    String.raw`COMMENT\s+ON\s+TABLE\s+(` + QUALIFIED_NAME + String.raw`)\s+IS\s+'([^']*)'`,
    "giu",
  );
  for (const match of sqlSource.matchAll(commentOnTableRe)) {
    const table = normalizeTableName(match[1]!);
    if (table) ensure(table).tableComment = match[2] ?? "";
  }
  // `COMMENT ON COLUMN <限定名>."<列>" IS '...'`：限定名贪吃后回溯出让最后一段作列名
  const commentOnColumnRe = new RegExp(
    String.raw`COMMENT\s+ON\s+COLUMN\s+(` +
      QUALIFIED_NAME +
      String.raw`)\s*\.\s*([\w$]+|"[^"]*")\s+IS\s+'([^']*)'`,
    "giu",
  );
  for (const match of sqlSource.matchAll(commentOnColumnRe)) {
    const table = normalizeTableName(match[1]!);
    if (table) {
      ensure(table).columns[match[2]!.replace(/"/gu, "").toLowerCase()] = match[3] ?? "";
    }
  }

  // CREATE TABLE 块内的内联 COMMENT（MySQL 方言，兼容反引号/双引号）
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?"?([\w$.]+)"?`?\s*\(([\s\S]*?)\)\s*(?:ENGINE|COMMENT|TABLESPACE|;|$)/giu;
  for (const match of sqlSource.matchAll(createRe)) {
    const table = normalizeTableName(match[1]!);
    if (!table) continue;
    const entry = ensure(table);
    const body = match[2] ?? "";
    // 逐列：`col` type ... COMMENT 'x'
    for (const columnMatch of body.matchAll(/`?"?(\w+)"?`?\s+[a-zA-Z][\w()]*[^,]*?COMMENT\s+'((?:[^']|'')*)'/giu)) {
      entry.columns[columnMatch[1]!.toLowerCase()] = (columnMatch[2] ?? "").replace(/''/gu, "'");
    }
    // 表级注释在最后一个闭括号之后、语句分号之前（如 `) COMMENT = '...'`）。
    const statementEnd = sqlSource.indexOf(";", match.index ?? 0);
    const statement = sqlSource.slice(
      match.index ?? 0,
      statementEnd === -1 ? undefined : statementEnd,
    );
    const lastParenIndex = statement.lastIndexOf(")");
    const tableCommentMatch = /COMMENT\s*=?\s*'((?:[^']|'')*)'/u.exec(
      statement.slice(lastParenIndex + 1),
    );
    if (tableCommentMatch) {
      entry.tableComment = tableCommentMatch[1]!.replace(/''/gu, "'");
    }
  }
  return result;
}

// ============================================================================
// 配置发现（YAML）
// ============================================================================

export interface DiscoveredNacos {
  serverAddr: string;
  namespace?: string;
  username?: string;
  password?: string;
}

/** 从 application-*.yml / bootstrap.yml 文本中发现 nacos 配置与数据源 URL。 */
export function discoverNacosFromYml(ymlText: string): DiscoveredNacos | null {
  if (!/nacos/iu.test(ymlText)) {
    return null;
  }
  const serverAddr = /server-addr\s*:\s*([^\s#]+)/u.exec(ymlText)?.[1];
  if (!serverAddr) {
    return null;
  }
  return {
    serverAddr,
    namespace: /namespace\s*:\s*([^\s#]+)/u.exec(ymlText)?.[1],
    username: /username\s*:\s*([^\s#]+)/u.exec(ymlText)?.[1],
    password: /password\s*:\s*([^\s#]+)/u.exec(ymlText)?.[1],
  };
}

export function discoverDatasourceUrls(ymlOrPropsText: string): string[] {
  const urls = new Set<string>();
  for (const match of ymlOrPropsText.matchAll(/jdbc:[a-z0-9]+:\/\/[^\s"'#]+/giu)) {
    urls.add(match[0]);
  }
  return [...urls];
}

// ============================================================================
// 前端证据（PC 多页站 + H5 Vue）
// ============================================================================

/** utils.ajaxPOST('doc/xxx', ...) / http.post("doc/xxx") / request({url:'/xxx'}) 调用点。 */
export function extractHttpUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(
    /\.\s*ajax(?:POST|GET|Put|Delete|post|get|put|delete)\s*\(\s*['"]([^'"]+)['"]/gu,
  )) {
    urls.add(match[1]!);
  }
  for (const match of text.matchAll(
    /(?:http|request|newOAHttp)\s*\.\s*(?:post|get|put|delete)\s*\(\s*['"]([^'"]+)['"]/gu,
  )) {
    urls.add(match[1]!);
  }
  for (const match of text.matchAll(/url\s*:\s*['"]([^'"]+)['"]/gu)) {
    urls.add(match[1]!);
  }
  return [...urls];
}

/** HTML 页面标题（<title>收文待办</title>）。 */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title>([^<>]{1,60})<\/title>/iu.exec(html);
  const title = match?.[1]?.trim();
  return title && !/^(index|untitled)/iu.test(title) ? title : null;
}

/** H5 api.js 模块：`// 中文说明\nexport function name(){ url: '/xxx' }` 对（url 可在函数体后续行）。 */
export function extractApiModuleEntries(text: string): Array<{ name: string; url: string; comment: string }> {
  const entries: Array<{ name: string; url: string; comment: string }> = [];
  const lines = text.split(/\r?\n/u);
  let pendingComment = "";
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("//")) {
      pendingComment = trimmed.replace(/^\/\/+\s*/u, "").trim();
      continue;
    }
    const exportMatch = /export\s+function\s+(\w+)/u.exec(trimmed);
    if (exportMatch) {
      const fnName = exportMatch[1]!;
      // url 常在函数体下一行：request({ url: '/xxx', ... })
      let url = "";
      for (let ahead = index; ahead < Math.min(index + 6, lines.length); ahead += 1) {
        const urlMatch = /url\s*:\s*['"]([^'"]+)['"]/u.exec(lines[ahead]!);
        if (urlMatch) {
          url = urlMatch[1]!;
          break;
        }
        if (ahead > index && lines[ahead]!.trim().startsWith("}")) {
          break;
        }
      }
      entries.push({ name: fnName, url, comment: pendingComment });
      pendingComment = "";
      continue;
    }
    if (trimmed === "") {
      pendingComment = "";
    }
  }
  return entries.filter((entry) => entry.url || entry.comment);
}

/** 路由/导入行尾中文注释：`import x from "@/pages/y"; //添加收文`、`path: "/z", //收文批示督办单 详情`。 */
export function extractRouterChineseComments(text: string): Array<{ route: string; comment: string }> {
  const entries: Array<{ route: string; comment: string }> = [];
  for (const match of text.matchAll(
    /(?:path\s*:\s*['"]([^'"]+)['"]|import\s+\w+\s+from\s+['"][^'"]+['"])\s*[,;]?\s*\/\/\s*([\u4e00-\u9fa5][\u4e00-\u9fa5\w（）()\- ]{0,30})/gu,
  )) {
    entries.push({ route: match[1] ?? "", comment: match[2]!.trim() });
  }
  return entries;
}

/** SYSTEM_MODULES_MAP.md 的 `**中文名** `(../view/path.html)` 对（路径带反引号）。 */
export function extractModuleMapEntries(text: string): Array<{ name: string; path: string }> {
  const entries: Array<{ name: string; path: string }> = [];
  for (const match of text.matchAll(/\*\*([^*\n]{1,30})\*\*\s*`?\(\.\.\/([^)`\n]+)`?\)/gu)) {
    entries.push({ name: match[1]!.trim(), path: match[2]!.trim() });
  }
  return entries;
}

/** URL → 业务前缀（首段，去开头斜杠；如 doc/receiveDoc/x → doc）。 */
export function urlBusinessSegment(url: string): string {
  const clean = url.trim().replace(/^https?:\/\/[^/]+/iu, "").replace(/^\/+/u, "");
  const first = clean.split(/[/?]/u)[0] ?? "";
  return first.toLowerCase();
}

/** 表名 → 业务前缀（去 oa_/xt_/sys_/t_ 前缀后的首段；如 oa_doc_transfer → doc）。 */
export function tableBusinessSegment(table: string): string {
  const stripped = table
    .replace(/^(oa|xt|sys|t|act)_/iu, "")
    .replace(/^_/u, "");
  return (stripped.split("_")[0] ?? "").toLowerCase();
}

/** 前端证据是否命中某张表（URL 首段 ↔ 表业务前缀）。 */
export function frontendMatchesTable(urls: readonly string[], table: string): boolean {
  const tableSegment = tableBusinessSegment(table);
  if (!tableSegment) {
    return false;
  }
  return urls.some((url) => urlBusinessSegment(url) === tableSegment);
}

// ============================================================================
// 证据文件分类与增量映射
// ============================================================================

export type EvidenceFileKind =
  | "entity"
  | "mapper-xml"
  | "ddl"
  | "app-yml"
  | "controller"
  | "service"
  | "pc-page-js"
  | "pc-html"
  | "h5-vue"
  | "h5-router"
  | "h5-api"
  | "modules-map"
  | "other";

export function classifyEvidenceFile(relPath: string): EvidenceFileKind {
  const normalized = relPath.replace(/\\/gu, "/").toLowerCase();
  if (/(^|\/)domain\/\w*entity\.java$/u.test(normalized) || normalized.endsWith("entity.java")) {
    return "entity";
  }
  if (/mapper\/.*mapper\.xml$/u.test(normalized) || normalized.endsWith("mapper.xml")) {
    return "mapper-xml";
  }
  if (normalized.endsWith(".sql")) {
    return "ddl";
  }
  if (/application[\w.-]*\.ya?ml$/u.test(normalized) || /bootstrap[\w.-]*\.ya?ml$/u.test(normalized)) {
    return "app-yml";
  }
  if (normalized.endsWith("controller.java")) {
    return "controller";
  }
  if (normalized.endsWith("service.java") || normalized.endsWith("serviceimpl.java")) {
    return "service";
  }
  // PC 多页站：页面逻辑 js 与页面 html（views/**.html ↔ assets/js-v/**.js 同名配对）
  if (/assets\/js-v\/.*\.js$/u.test(normalized)) {
    return "pc-page-js";
  }
  if (/views\/.*\.html$/u.test(normalized)) {
    return "pc-html";
  }
  // H5 Vue：路由 / api 模块 / 页面
  if (normalized.endsWith("src/router/index.js")) {
    return "h5-router";
  }
  if (normalized.endsWith("api.js") && normalized.includes("src/")) {
    return "h5-api";
  }
  if (normalized.endsWith(".vue")) {
    return "h5-vue";
  }
  // PC 文档：模块地图（菜单中文名 → 页面）
  if (/docs\/[\w-]*modules[\w-]*\.md$/u.test(normalized)) {
    return "modules-map";
  }
  return "other";
}

/** 增量：变更文件清单 → 受影响表（经 表→证据文件 反向索引）。 */
export function mapChangedFilesToTables(
  changedFiles: readonly string[],
  tableEvidenceIndex: ReadonlyMap<string, readonly string[]>,
): string[] {
  const changed = new Set(changedFiles.map((file) => file.replace(/\\/gu, "/")));
  const affected: string[] = [];
  for (const [table, files] of tableEvidenceIndex) {
    if (files.some((file) => changed.has(file.replace(/\\/gu, "/")))) {
      affected.push(table);
    }
  }
  return affected;
}
