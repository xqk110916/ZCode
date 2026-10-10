import test from "node:test";
import assert from "node:assert/strict";
import {
  DB_BOARD_BINARY_MARKER_PREFIX,
  assertColumnsKnown,
  buildDeleteByPkSql,
  buildInsertReturningSql,
  buildPkObject,
  buildQueryRowsSql,
  buildSelectByPkSql,
  buildUpdateByPkReturningSql,
  containsBinaryMarker,
  getColumnMeta,
  isReadOnlyColumn,
  isValidIdentifier,
  normalizeRowForWire,
  quoteIdentifier,
  quoteQualifiedName,
  resolveColumnFamily,
  stripSqlCommentsAndTrim,
  validateDashboardSqlHead,
  wrapReadOnlySelect,
} from "../src/dbBoard/dbBoardSql.js";
import type { DbBoardColumnMeta } from "../src/dbBoard/dbBoard.js";

function columnMeta(overrides: Partial<DbBoardColumnMeta> = {}): DbBoardColumnMeta {
  return {
    name: "id",
    dataType: "integer",
    family: "number",
    nullable: false,
    isPrimaryKey: true,
    hasDefault: true,
    ...overrides,
  };
}

test("标识符白名单拒绝注入与非法字符", () => {
  assert.equal(isValidIdentifier("valid_name"), true);
  assert.equal(isValidIdentifier("col$1"), true);
  assert.equal(isValidIdentifier("1abc"), false);
  assert.equal(isValidIdentifier('name"; DROP TABLE x; --'), false);
  assert.equal(isValidIdentifier("a".repeat(64)), false);
  assert.throws(() => quoteIdentifier('x"; --'));
  assert.throws(() => quoteQualifiedName("public", 't; drop table y'));
  assert.equal(quoteQualifiedName("PUBLIC", "act_evt_log"), '"PUBLIC"."act_evt_log"');
});

test("类型分族兼容 Kingbase 全大写与 PG 小写", () => {
  // Kingbase V8R3 实测：data_type/udt_name 全大写
  assert.equal(resolveColumnFamily("CHARACTER VARYING", "VARCHAR"), "text");
  assert.equal(resolveColumnFamily("BIGINT", "INT8"), "number");
  assert.equal(resolveColumnFamily("TINYINT", "TINYINT"), "number");
  assert.equal(resolveColumnFamily("TIMESTAMP WITHOUT TIME ZONE", "TIMESTAMP"), "timestamp");
  assert.equal(resolveColumnFamily("BYTEA", "BYTEA"), "binary");
  assert.equal(resolveColumnFamily("integer", "_int4"), "array");
  assert.equal(resolveColumnFamily("integer", undefined), "number");
  assert.equal(resolveColumnFamily("ARRAY", "_text"), "array");
  // 枚举/未知 → other（按文本编辑）
  assert.equal(resolveColumnFamily("USER-DEFINED", "status_enum"), "other");
  // PG 小写口径
  assert.equal(resolveColumnFamily("character varying", "varchar"), "text");
  assert.equal(resolveColumnFamily("timestamp with time zone", "timestamptz"), "timestamp");
});

test("二进制/数组列为只读", () => {
  assert.equal(isReadOnlyColumn(columnMeta({ family: "binary" })), true);
  assert.equal(isReadOnlyColumn(columnMeta({ family: "array" })), true);
  assert.equal(isReadOnlyColumn(columnMeta({ family: "text" })), false);
});

test("wire 归一化：Date → ISO，Buffer → 占位标记", () => {
  const date = new Date("2026-10-09T04:49:26.665Z");
  const normalized = normalizeRowForWire({
    time: date,
    data: Buffer.from([1, 2, 3]),
    name: "hello",
    count: 5,
  });
  assert.equal(normalized.time, "2026-10-09T04:49:26.665Z");
  assert.equal(normalized.data, `${DB_BOARD_BINARY_MARKER_PREFIX}3B`);
  assert.equal(normalized.name, "hello");
  assert.equal(normalized.count, 5);
  assert.equal(containsBinaryMarker(normalized), true);
  assert.equal(containsBinaryMarker({ a: 1, b: "text" }), false);
});

test("元数据白名单：未知列被拒绝", () => {
  const columns = [columnMeta(), columnMeta({ name: "name", isPrimaryKey: false })];
  assert.doesNotThrow(() => assertColumnsKnown(["id", "name"], columns));
  assert.throws(() => assertColumnsKnown(["id", "ghost"], columns));
  assert.equal(getColumnMeta(columns, "name")?.name, "name");
  assert.equal(getColumnMeta(columns, "ghost"), undefined);
});

test("pk 对象按主键列顺序稳定构造", () => {
  const pkColumns = [columnMeta({ name: "b" }), columnMeta({ name: "a" })];
  const pk = buildPkObject({ a: 1, b: "x", other: true }, pkColumns);
  assert.deepEqual(pk, { b: "x", a: 1 });
  assert.equal(JSON.stringify(pk), '{"b":"x","a":1}');
});

test("CRUD SQL 构建与占位符顺序", () => {
  const pks = [columnMeta({ name: "id" })];
  assert.equal(
    buildSelectByPkSql('"PUBLIC"."t"', pks),
    'SELECT * FROM "PUBLIC"."t" WHERE "id" = $1',
  );
  assert.equal(
    buildSelectByPkSql('"PUBLIC"."t"', pks, { forUpdate: true }),
    'SELECT * FROM "PUBLIC"."t" WHERE "id" = $1 FOR UPDATE',
  );
  assert.equal(
    buildInsertReturningSql('"PUBLIC"."t"', ["name", "age"]),
    'INSERT INTO "PUBLIC"."t" ("name", "age") VALUES ($1, $2) RETURNING *',
  );
  assert.equal(
    buildUpdateByPkReturningSql('"PUBLIC"."t"', pks, ["name", "age"]),
    'UPDATE "PUBLIC"."t" SET "name" = $1, "age" = $2 WHERE "id" = $3 RETURNING *',
  );
  // 全仓库唯一 DELETE 构建点（仅回退事务调用）
  assert.equal(buildDeleteByPkSql('"PUBLIC"."t"', pks), 'DELETE FROM "PUBLIC"."t" WHERE "id" = $1');
  // 复合主键
  const composite = [columnMeta({ name: "k1" }), columnMeta({ name: "k2", dataType: "text", family: "text" })];
  assert.equal(
    buildSelectByPkSql('"PUBLIC"."t"', composite),
    'SELECT * FROM "PUBLIC"."t" WHERE "k1" = $1 AND "k2" = $2',
  );
});

test("分页查询：有主键按主键排序，无主键退化为 ctid", () => {
  const withPk = buildQueryRowsSql({
    qualifiedTable: '"PUBLIC"."t"',
    pkColumns: [columnMeta({ name: "id" })],
    searchColumn: "name",
  });
  assert.equal(
    withPk.listSql,
    'SELECT * FROM "PUBLIC"."t" WHERE "name"::text ILIKE $1 ORDER BY "id" LIMIT $2 OFFSET $3',
  );
  assert.equal(withPk.countSql, 'SELECT count(*)::text AS total FROM "PUBLIC"."t" WHERE "name"::text ILIKE $1');
  assert.equal(withPk.hasSearch, true);

  const noPk = buildQueryRowsSql({ qualifiedTable: '"PUBLIC"."t"', pkColumns: [] });
  assert.equal(
    noPk.listSql,
    "SELECT * FROM \"PUBLIC\".\"t\"  ORDER BY ctid LIMIT $1 OFFSET $2",
  );
  assert.equal(noPk.hasSearch, false);
});

test("看板 SQL 语句头校验：注释剥离、分号容忍、非法拒绝", () => {
  assert.equal(stripSqlCommentsAndTrim("-- lead comment\nSELECT 1"), "SELECT 1");
  assert.equal(stripSqlCommentsAndTrim("/* block */ WITH x AS (SELECT 1) SELECT * FROM x;"), "WITH x AS (SELECT 1) SELECT * FROM x");

  assert.deepEqual(validateDashboardSqlHead("SELECT 1"), { ok: true, body: "SELECT 1" });
  assert.deepEqual(validateDashboardSqlHead("with t as (select 1) select * from t"), {
    ok: true,
    body: "with t as (select 1) select * from t",
  });
  assert.equal(validateDashboardSqlHead("DELETE FROM t").ok, false);
  assert.equal(validateDashboardSqlHead("INSERT INTO t VALUES (1)").ok, false);
  assert.equal(validateDashboardSqlHead("UPDATE t SET a = 1").ok, false);
  assert.equal(validateDashboardSqlHead("SELECT 1; DROP TABLE t").ok, false);
  assert.equal(validateDashboardSqlHead("").ok, false);
  assert.equal(validateDashboardSqlHead("SELECT 1;\0").ok, false);
});

test("只读包装：子查询外层 + 行上限，多语句/INTO 必然非法", () => {
  const wrapped = wrapReadOnlySelect("SELECT a, b FROM t WHERE c > 10", 100);
  assert.match(wrapped, /^SELECT \* FROM \(\nSELECT a, b FROM t WHERE c > 10\n\) AS _db_board_sub LIMIT 100$/);
  // 行上限收敛到全局上限
  assert.match(wrapReadOnlySelect("SELECT 1", 99_999_999), /LIMIT 1000$/);
  // 非 SELECT 拒绝包装
  assert.throws(() => wrapReadOnlySelect("DELETE FROM t", 10));
});
