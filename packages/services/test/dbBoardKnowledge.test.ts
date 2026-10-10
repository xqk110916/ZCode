import test from "node:test";
import assert from "node:assert/strict";
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
  tableBusinessSegment,
  urlBusinessSegment,
} from "../src/dbBoardKnowledge/dbBoardKnowledgeExtract.js";
import {
  buildDistillPrompt,
  buildFallbackCard,
  buildKnowledgeCardsText,
  buildTableSelectionPrompt,
  mergeColumnMeanings,
  parseTableCardsDraft,
  parseTableSelection,
  type DistillTableEvidence,
} from "../src/dbBoardKnowledge/dbBoardKnowledgePrompt.js";
import {
  extractJdbcUrlsFromConfig,
  serviceNameFromDataId,
} from "../src/dbBoardKnowledge/nacosClient.js";

const ENTITY_SAMPLE = `package com.zcst.modules.car.domain;
import com.baomidou.mybatisplus.annotations.TableName;

/**
 * 车辆事故记录
 */
@Data
@TableName("oa_car_accident")
public class AccidentEntity {
    /**
     * 事故id
     */
    @TableId(value = "id", type = IdType.ID_WORKER_STR)
    private String id;

    /**
     * 车牌号
     */
    @TableField("plate_num")
    private String plateNum;

    /**
     * 发生时间
     */
    @TableField("happen_time")
    private String happenTime;

    private String noComment;
}`;

test("实体抽取：@TableName + 字段中文 javadoc + 缺省驼峰转下划线", () => {
  const evidence = extractEntityEvidence(ENTITY_SAMPLE);
  assert.equal(evidence.tableName, "oa_car_accident");
  assert.equal(evidence.className, "AccidentEntity");
  assert.equal(evidence.classComment, "车辆事故记录");
  const byColumn = new Map(evidence.fields.map((field) => [field.column, field]));
  assert.equal(byColumn.get("id")?.comment, "事故id");
  assert.equal(byColumn.get("plate_num")?.comment, "车牌号");
  assert.equal(byColumn.get("happen_time")?.comment, "发生时间");
  // 无注释也无显式列名的字段不收录
  assert.equal(byColumn.has("no_comment"), false);
});

const MAPPER_SAMPLE = `<?xml version="1.0"?>
<mapper namespace="com.zcst.modules.car.mapper.CarApplyMapper">
    <sql id="tableName">oa_car_apply</sql>
    <sql id="CarApplyVo">ca.id, ca.plate_num, u.REALNAME</sql>

    <!-- 车辆使用情况列表 -->
    <select id="getCarUseConditionsList" parameterType="QueryDto" resultMap="VoResultMap">
        SELECT
        <include refid="CarApplyVo"/>
        FROM
        <include refid="tableName"></include> ca
        LEFT JOIN oa_car_apply_related ocar ON ocar.apply_id = ca.id
        LEFT JOIN xt_user u ON u.USER_ID = ca.apply_user_id
        <where>
            <if test="delFlag != null and delFlag != ''">
                AND ca.del_flag = #{delFlag}
            </if>
        </where>
        ORDER BY ca.create_time DESC
    </select>

    <resultMap id="VoResultMap" type="com.zcst.modules.car.domain.CarApplyVo">
        <result column="REALNAME" property="realName"/>
    </ resultMap>
</mapper>`;

test("Mapper 抽取：include 解析、表引用与 join 关系", () => {
  const evidence = extractMapperEvidence(MAPPER_SAMPLE);
  assert.ok(evidence.tables.includes("oa_car_apply"), JSON.stringify(evidence.tables));
  assert.ok(evidence.tables.includes("oa_car_apply_related"));
  assert.ok(evidence.tables.includes("xt_user"));
  const joinTargets = evidence.joins.map((join) => join.target);
  assert.ok(joinTargets.includes("oa_car_apply_related"));
  assert.ok(joinTargets.includes("xt_user"));
  const relatedJoin = evidence.joins.find((join) => join.target === "oa_car_apply_related");
  assert.match(relatedJoin?.on ?? "", /ocar\.apply_id\s*=\s*ca\.id/u);
  assert.ok(evidence.statementIds.includes("getCarUseConditionsList"));
  // include 解析后 SQL 里应能看到表名片段
  assert.match(evidence.resolvedSql, /oa_car_apply/u);
});

const DDL_SAMPLE = `
CREATE TABLE \`archives_borrow\`  (
  \`borrow_no\` varchar(64) NOT NULL COMMENT '登记号',
  \`user_id\` varchar(32) NOT NULL COMMENT '申请人',
  PRIMARY KEY (\`borrow_no\`)
) COMMENT = '档案借阅登记';

COMMENT ON TABLE "PUBLIC"."oa_leader_schedule" IS '领导日程';
COMMENT ON COLUMN "PUBLIC"."oa_leader_schedule"."leader_name" IS '领导姓名';
`;

test("DDL 注释抽取：MySQL 内联与 COMMENT ON 双方言", () => {
  const comments = extractDdlComments(DDL_SAMPLE);
  assert.equal(comments.get("archives_borrow")?.columns["borrow_no"], "登记号");
  assert.equal(comments.get("archives_borrow")?.columns["user_id"], "申请人");
  assert.equal(comments.get("archives_borrow")?.tableComment, "档案借阅登记");
  assert.equal(comments.get("oa_leader_schedule")?.tableComment, "领导日程");
  assert.equal(comments.get("oa_leader_schedule")?.columns["leader_name"], "领导姓名");
});

test("YAML 发现：Nacos 配置与数据源 URL", () => {
  const yml = `
nacos:
  config:
    server-addr: 10.41.108.150:8848
    namespace: 94cafac4-86fe-4486
    username: nacos
    password: secret123
    file-extension: yaml
`;
  const nacos = discoverNacosFromYml(yml);
  assert.equal(nacos?.serverAddr, "10.41.108.150:8848");
  assert.equal(nacos?.username, "nacos");
  assert.equal(nacos?.password, "secret123");
  assert.equal(discoverNacosFromYml("spring:\n  application:\n    name: x"), null);
  assert.deepEqual(discoverDatasourceUrls("url: jdbc:kingbase8://10.41.108.150:54321/hbt_test"), [
    "jdbc:kingbase8://10.41.108.150:54321/hbt_test",
  ]);
});

test("证据文件分类", () => {
  assert.equal(classifyEvidenceFile("oa-common/src/main/java/com/zcst/modules/car/domain/AccidentEntity.java"), "entity");
  assert.equal(classifyEvidenceFile("oa-common/src/main/resources/mapper/car/CarApplyMapper.xml"), "mapper-xml");
  assert.equal(classifyEvidenceFile("oa-admin/db/new_oa20200728.sql"), "ddl");
  assert.equal(classifyEvidenceFile("oa-admin/src/main/resources/application-dev.yml"), "app-yml");
  assert.equal(classifyEvidenceFile("oa-common/src/main/java/com/zcst/modules/car/controller/CarController.java"), "controller");
  assert.equal(classifyEvidenceFile("oa-common/src/main/java/com/zcst/modules/car/service/CarService.java"), "service");
  assert.equal(classifyEvidenceFile("oa-common/src/main/java/com/zcst/modules/car/util/Helper.java"), "other");
});

test("增量映射：变更文件反查受影响表", () => {
  const index = new Map<string, readonly string[]>([
    ["oa_car_apply", ["oa-common/src/main/resources/mapper/car/CarApplyMapper.xml"]],
    ["archives_document", ["oa-common/src/main/java/com/zcst/modules/archives/domain/DocumentEntity.java"]],
  ]);
  const affected = mapChangedFilesToTables(
    ["oa-common\\src\\main\\resources\\mapper\\car\\CarApplyMapper.xml", "README.md"],
    index,
  );
  assert.deepEqual(affected, ["oa_car_apply"]);
});

const DISTILL_DRAFT_JSON = JSON.stringify({
  cards: [
    {
      table: "oa_car_apply",
      domain: "车辆管理",
      purpose: "记录公车申请与审批流转",
      keyColumns: [{ name: "apply_status", meaning: "申请状态" }],
      relations: [{ target: "xt_user", on: "apply_user_id = USER_ID", kind: "left-join" }],
    },
  ],
});

test("蒸馏输出解析：围栏/结构校验/非法拒绝", () => {
  const ok = parseTableCardsDraft(`\`\`\`json\n${DISTILL_DRAFT_JSON}\n\`\`\``);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.cards[0]!.table, "oa_car_apply");
    assert.equal(ok.cards[0]!.domain, "车辆管理");
  }
  assert.equal(parseTableCardsDraft("没有 JSON").ok, false);
  assert.equal(parseTableCardsDraft('{"cards":[]}').ok, false);
  assert.equal(parseTableCardsDraft('{"cards":[{"table":"t","domain":"","purpose":"x"}]}').ok, false);
});

test("选表输出解析", () => {
  assert.deepEqual(parseTableSelection('{"tables":["oa_car_apply","xt_user"]}'), [
    "oa_car_apply",
    "xt_user",
  ]);
  assert.equal(parseTableSelection('{"tables":[]}'), null);
  assert.equal(parseTableSelection("noise"), null);
});

function sampleEvidence(): DistillTableEvidence {
  return {
    table: "oa_car_apply",
    domain: "车辆管理",
    entity: { className: "CarApplyEntity", classComment: "公车申请" },
    entityFields: [
      { column: "plate_num", comment: "车牌号" },
      { column: "apply_status", comment: "" },
    ],
    ddlComments: { tableComment: "公车申请表", columns: { apply_status: "申请状态" } },
    dbComments: { tableComment: "", columns: { plate_num: "车牌（库注释）" } },
    mapperSql: "SELECT ca.id FROM oa_car_apply ca LEFT JOIN xt_user u ON u.USER_ID = ca.apply_user_id",
    operations: ["getCarUseConditionsList", "CarController"],
  };
}

test("列含义合并：实体 javadoc > DB 注释 > DDL COMMENT（同列先到先得）", () => {
  const merged = new Map(mergeColumnMeanings(sampleEvidence()).map((item) => [item.name, item.meaning]));
  assert.equal(merged.get("plate_num"), "车牌号");
  assert.equal(merged.get("apply_status"), "申请状态");
});

test("蒸馏 prompt 包含表/字段/SQL 关联证据", () => {
  const prompt = buildDistillPrompt([sampleEvidence()]);
  assert.match(prompt, /oa_car_apply/u);
  assert.match(prompt, /车牌号/u);
  assert.match(prompt, /LEFT JOIN xt_user/u);
  assert.match(prompt, /getCarUseConditionsList/u);
  assert.match(prompt, /只输出 JSON/u);
});

test("纯抽取降级卡与知识卡片文本", () => {
  const fallback = buildFallbackCard(sampleEvidence(), ["mapper/car/CarApplyMapper.xml"]);
  assert.equal(fallback.table, "oa_car_apply");
  assert.equal(fallback.source, "extracted");
  assert.deepEqual(fallback.evidenceFiles, ["mapper/car/CarApplyMapper.xml"]);
  assert.ok(fallback.purpose.length > 0);

  const knowledge = {
    version: 1 as const,
    builtAt: "2026-10-09T00:00:00.000Z",
    domains: { 车辆管理: ["oa_car_apply"] },
    tables: {
      oa_car_apply: {
        table: "oa_car_apply",
        domain: "车辆管理",
        purpose: "记录公车申请与审批流转",
        keyColumns: [{ name: "apply_status", meaning: "申请状态" }],
        relations: [{ target: "xt_user", on: "apply_user_id = USER_ID" }],
        evidenceFiles: [],
        source: "distilled" as const,
      },
    },
    repoSnapshots: [],
    stats: {
      tableCount: 1,
      domainCount: 1,
      distilled: 1,
      extracted: 0,
      dbCommentOnly: 0,
    },
  };
  const selectionPrompt = buildTableSelectionPrompt(knowledge, "今年的公车申请有多少");
  assert.match(selectionPrompt, /oa_car_apply：记录公车申请与审批流转/u);
  const cardsText = buildKnowledgeCardsText(knowledge, ["oa_car_apply"]);
  assert.match(cardsText, /oa_car_apply（车辆管理）/u);
  assert.match(cardsText, /apply_user_id = USER_ID/u);
});

test("Nacos 纯函数：jdbc 提取与 dataId → 服务名", () => {
  assert.deepEqual(extractJdbcUrlsFromConfig("spring.datasource.url: jdbc:kingbase8://10.41.108.150:54321/hbt_test"), [
    "jdbc:kingbase8://10.41.108.150:54321/hbt_test",
  ]);
  assert.equal(serviceNameFromDataId("oa-admin.yaml"), "oa-admin");
  assert.equal(serviceNameFromDataId("application-prod.yml"), "prod");
  assert.equal(serviceNameFromDataId("hbt-oa.json"), "hbt-oa");
});

// ============================================================================
// 前端证据抽取
// ============================================================================

test("前端 HTTP URL 抽取：PC utils.ajax* / H5 http.* / request({url})", () => {
  const pc = `
    utils.ajaxPOST('doc/receiveDoc/queryListFromExchange', _this.data, function (res) {})
    utils.ajaxGET( "doc/manager/know" , cb)
  `;
  assert.deepEqual(extractHttpUrls(pc), ["doc/receiveDoc/queryListFromExchange", "doc/manager/know"]);
  const h5 = `
    http.post("doc/get", form)
    http.get('/workflow/task/pending/combined')
  `;
  assert.deepEqual(extractHttpUrls(h5), ["doc/get", "/workflow/task/pending/combined"]);
  const apiModule = `export function flowSubmit(data){ return request({ url: '/workflow/flowCenter/flowSubmit', method: 'post', data }); }`;
  assert.deepEqual(extractHttpUrls(apiModule), ["/workflow/flowCenter/flowSubmit"]);
});

test("HTML 标题与模块地图抽取", () => {
  assert.equal(extractHtmlTitle("<html><head><title>收文待办</title></head></html>"), "收文待办");
  assert.equal(extractHtmlTitle("<title>index</title>"), null);
  const map = `- 📄 [页面] **督察督办待办** \`(../workplan/transact-list.html)\` **[权限: workplan:approve]**`;
  const entries = extractModuleMapEntries(map);
  assert.equal(entries[0]?.name, "督察督办待办");
  assert.equal(entries[0]?.path, "workplan/transact-list.html");
});

test("H5 api 模块与路由中文注释抽取", () => {
  const api = `
// 提交
export function flowSubmit(data) {
  return request({ url: '/workflow/flowCenter/flowSubmit', method: 'post', data });
}
export function queryDetail(id){
  return request({ url: '/base/detail', method: 'get' });
}
`;
  const entries = extractApiModuleEntries(api);
  assert.equal(entries[0]?.name, "flowSubmit");
  assert.equal(entries[0]?.comment, "提交");
  assert.equal(entries[0]?.url, "/workflow/flowCenter/flowSubmit");
  assert.equal(entries[1]?.comment, "");

  const router = `
import launchReceiving from "@/pages/launchReceiving"; //添加收文
{ path: "/dubanQuery", //收文批示督办单 详情
  name: "dubanQuery" }
`;
  const routes = extractRouterChineseComments(router);
  assert.deepEqual(routes[0], { route: "", comment: "添加收文" });
  assert.deepEqual(routes[1], { route: "/dubanQuery", comment: "收文批示督办单 详情" });
});

test("URL 首段 ↔ 表业务前缀匹配（oa_doc ↔ doc/*）", () => {
  assert.equal(urlBusinessSegment("doc/receiveDoc/queryListFromExchange"), "doc");
  assert.equal(urlBusinessSegment("/workflow/task/pending"), "workflow");
  assert.equal(tableBusinessSegment("oa_doc_transfer"), "doc");
  assert.equal(tableBusinessSegment("xt_user"), "user");
  assert.equal(tableBusinessSegment("oa_car_apply"), "car");
  assert.equal(frontendMatchesTable(["doc/receiveDoc/x", "flow/y"], "oa_doc"), true);
  assert.equal(frontendMatchesTable(["flow/y"], "oa_doc"), false);
  assert.equal(frontendMatchesTable(["workplan/transact-list.html"], "oa_workplan"), true);
});

test("前端证据文件分类", () => {
  assert.equal(classifyEvidenceFile("hbt-oa-web/assets/js-v/sys/officfile/file-receive-list.js"), "pc-page-js");
  assert.equal(classifyEvidenceFile("hbt-oa-web/views/sys/officfile/file-receive-list.html"), "pc-html");
  assert.equal(classifyEvidenceFile("hbt-oa-h5/src/router/index.js"), "h5-router");
  assert.equal(classifyEvidenceFile("hbt-oa-h5/src/pages/newOADocument/components/api.js"), "h5-api");
  assert.equal(classifyEvidenceFile("hbt-oa-h5/src/pages/launchReceiving.vue"), "h5-vue");
  assert.equal(classifyEvidenceFile("hbt-oa-web/docs/SYSTEM_MODULES_MAP.md"), "modules-map");
});
