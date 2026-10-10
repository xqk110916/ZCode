import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DbBoardKnowledgeTableCard } from "../src/dbBoardKnowledge/dbBoardKnowledge.js";
import {
  DB_BOARD_USAGE_MIN_ROWS,
  DB_BOARD_USAGE_TOP_N,
  buildDbBoardUsageSummary,
} from "../src/dbBoard/dbBoardUsageSummary.js";

function card(table: string, domain: string, purpose = `${table} 用途`): DbBoardKnowledgeTableCard {
  return { table, domain, purpose, keyColumns: [], relations: [], evidenceFiles: [], source: "distilled" };
}

const knowledge = {
  domains: { 收发文: ["oa_doc", "oa_doc_transfer"], 用户组织: ["xt_user"] },
  tables: {
    oa_doc: card("oa_doc", "收发文"),
    oa_doc_transfer: card("OA_DOC_TRANSFER", "收发文"),
    xt_user: card("xt_user", "用户组织"),
  },
};

describe("buildDbBoardUsageSummary", () => {
  it("按行数降序列出 ≥ 阈值的表，行数未知/低于阈值不进入", () => {
    const summary = buildDbBoardUsageSummary({
      now: "2026-10-10T00:00:00Z",
      tableCount: 275,
      knowledge,
      rowCountByTableLower: new Map([
        ["oa_doc", 23751],
        ["oa_doc_transfer", 1000],
        ["xt_user", 120],
        // 没有"缺席表"的行数
      ]),
    });
    assert.equal(summary.tableCount, 275);
    assert.equal(summary.knowledgeTableCount, 3);
    assert.equal(summary.domainCount, 2);
    assert.equal(summary.countedTableCount, 3);
    assert.deepEqual(
      summary.frequentTables.map((t) => t.table),
      ["oa_doc", "OA_DOC_TRANSFER"],
    );
    assert.equal(summary.frequentTables[0]!.rowCount, 23751);
    assert.equal(summary.rowCountSource, "count");
    // 全量行数表：含所有成功统计的表（不只 ≥ 阈值的），供数据浏览排序
    assert.deepEqual(summary.rowCounts, {
      oa_doc: 23751,
      oa_doc_transfer: 1000,
      xt_user: 120,
    });
  });

  it("只取前 N 张（topN 截断），并列名次稳定排序", () => {
    const tables: Record<string, DbBoardKnowledgeTableCard> = {};
    const rows = new Map<string, number>();
    for (let i = 1; i <= DB_BOARD_USAGE_TOP_N + 5; i += 1) {
      const name = `t_${String(i).padStart(3, "0")}`;
      tables[name] = card(name, "域");
      rows.set(name, DB_BOARD_USAGE_TOP_N + 5 - i + DB_BOARD_USAGE_MIN_ROWS);
    }
    const summary = buildDbBoardUsageSummary({
      now: "now",
      tableCount: 30,
      knowledge: { domains: { 域: Object.keys(tables) }, tables },
      rowCountByTableLower: rows,
    });
    assert.equal(summary.frequentTables.length, DB_BOARD_USAGE_TOP_N);
    assert.equal(summary.frequentTables[0]!.table, "t_001");
  });

  it("无知识库时覆盖数为 0、常用表为空", () => {
    const summary = buildDbBoardUsageSummary({
      now: "now",
      tableCount: 10,
      knowledge: null,
      rowCountByTableLower: new Map([["x", 5000]]),
    });
    assert.equal(summary.knowledgeTableCount, 0);
    assert.equal(summary.domainCount, 0);
    assert.deepEqual(summary.frequentTables, []);
    assert.equal(summary.countedTableCount, 0);
  });

  it("表名大小写与空白在匹配行数时归一", () => {
    const padded = {
      domains: { 收发文: [" OA_DOC "] },
      tables: { " OA_DOC ": card(" OA_DOC ", "收发文") },
    };
    const summary = buildDbBoardUsageSummary({
      now: "now",
      tableCount: 1,
      knowledge: padded,
      rowCountByTableLower: new Map([["oa_doc", 2000]]),
    });
    assert.equal(summary.frequentTables[0]!.table, " OA_DOC ");
    assert.equal(summary.frequentTables[0]!.rowCount, 2000);
  });
});
