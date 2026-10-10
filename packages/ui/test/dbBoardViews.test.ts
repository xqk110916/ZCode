import test from "node:test";
import assert from "node:assert/strict";
import { sortTablesByRowCount } from "../src/dbBoard/dbBoardViews.js";
import type { DbBoardTableMeta } from "@zcode/services";

function meta(name: string, schema = "PUBLIC"): DbBoardTableMeta {
  return { schema, name, hasPrimaryKey: true, columnCount: 3, queryOnly: false };
}

test("表列表排序：已统计按行数倒序，未统计靠后保持字母序", () => {
  const tables = [meta("aa_small"), meta("ZZ_BIG"), meta("mm_mid"), meta("no_count"), meta("bb_small")];
  const sorted = sortTablesByRowCount(tables, { zz_big: 900, mm_mid: 500, aa_small: 10, bb_small: 10 });
  assert.deepEqual(
    sorted.map((t) => t.name),
    ["ZZ_BIG", "mm_mid", "aa_small", "bb_small", "no_count"],
  );
});

test("无概览（rowCounts 为空）保持原有顺序", () => {
  const tables = [meta("b"), meta("a"), meta("c")];
  assert.deepEqual(
    sortTablesByRowCount(tables, null).map((t) => t.name),
    ["b", "a", "c"],
  );
});

test("行数并列按限定名字母序，表名大小写归一匹配", () => {
  const tables = [meta("B_TEN"), meta("a_ten"), meta("c_hundred")];
  const sorted = sortTablesByRowCount(tables, { b_ten: 10, a_ten: 10, c_hundred: 100 });
  assert.deepEqual(
    sorted.map((t) => t.name),
    ["c_hundred", "a_ten", "B_TEN"],
  );
});
