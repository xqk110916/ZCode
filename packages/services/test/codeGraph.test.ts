import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractHardcoded,
  extractJavaStructure,
  extractEndpoints,
  extractFrontendApiCalls,
  extractSpecialCases,
  buildGraphFromClass,
} from "../src/dbBoardKnowledge/codeGraphExtract.js";

// ============================================================================
// 测试数据：来自 roma.js 真实代码
// ============================================================================

const ROMA_JS = `
var selectType,form,element,layer ;
layui.use(['form', 'element',], function () {
    form.on('submit(*)', function (data) {
        var url=getUrlKey('type')==4 ? 'datumRecord/update': 'datumRecord/process';
        utils.ajaxPOST(url, datas, function (res) {});
    });
});
var vm = new Vue({
    methods: {
        getText: function () {
            let url = 'dictionaries/getLevels?DICTIONARIES_ID=14907770ee77b6cf5da0487747ee10fc'
            utils.ajaxGet(url, data, (res) => {});
        },
        findRole() {
            let id = "60dda1bdd7f6407988eb5d0ec663fc03"
            let name = '流转进度-人员过滤'
        },
        handleSelectData(treeData) {
            let username = window.localStorage.getItem('username')
            let flag = username === 'jiyaosw' || username === 'jiyao' || username === 'chengyilin'
            let data = treeData.find(item => item.id === 'HZ28e7f51e816d28011e816da7f1001f')
            let zsData = data.children.find(item => item.id === 'c16c7305a74c4e6ab9f89f1fc1c50ad5') || {}
            let guolijun = zsData.children.find(item => item.id === 'USER_2c7af79125b4452488ee53db6d60bc44')
            let wanghaijiang = zsData.children.find(item => item.id === 'USER_d0b011f99a2f4dcd8b78849a9b8393b2')
            jcaqzx.children = []
            if(wanghaijiang) jcaqzx.children.push(wanghaijiang)
            return [...TingData.children]
        },
    },
})
`;

const JAVA_SERVICE = `
package com.zcst.modules.flow.service.impl;

import org.springframework.beans.factory.annotation.Value;

@Service
public class FlowCommonServiceImpl {

    @Value("\${centerdeptid}")
    private String CENTER_DEPT_ID;

    @Value("\${roleId.CSLD}")
    private String ROLE_ID_CSLD;

    private String FIXED_ROLE_ID = "60dda1bdd7f6407988eb5d0ec663fc03";

    public List<TreeModel> getPersonTree(String roleId, String parentDeptId) {
        if (ROLE_ID_CSLD.equals(roleId) && "HZ28e7f51e816d28011e816da7f1001f".equals(parentDeptId)) {
            List<TreeModel> others = flowCommonMapper.getPersonByCondition(sql, true, false);
            return others;
        }
        List<TreeModel> personByCondition = flowCommonMapper.getPersonByCondition(sql, false, false);
        return personByCondition;
    }

    private String buildCondition(String flowKey) {
        String result = docCommandService.buildSql(flowKey);
        opinionService.appendCondition(result);
        return result;
    }
}
`;

const JAVA_CONTROLLER = `
package com.zcst.modules.doc.controller;

@RestController
@RequestMapping("/doc")
public class DocController {

    @GetMapping("/list")
    public Result list(DocQuery query) {
        return docService.list(query);
    }

    @PostMapping("/command")
    public Result executeCommand(@RequestBody DocCommand cmd) {
        return docCommandService.execute(cmd);
    }

    @DeleteMapping("/{id}")
    public Result delete(@PathVariable String id) {
        return docService.delete(id);
    }
}
`;

describe("extractHardcoded", () => {
  it("检测 roma.js 中的用户名硬编码", () => {
    const results = extractHardcoded(ROMA_JS, "views/sys/MaterialReg/roma.js");
    const usernames = results.filter((r) => r.node.metadata.kind === "username");
    const values = usernames.map((r) => r.node.metadata.value);
    assert.ok(values.includes("jiyaosw"), `应包含 jiyaosw，实际: ${values}`);
    assert.ok(values.includes("jiyao"), `应包含 jiyao`);
    assert.ok(values.includes("chengyilin"), `应包含 chengyilin`);
  });

  it("检测 roma.js 中的用户 ID（USER_ 前缀）", () => {
    const results = extractHardcoded(ROMA_JS, "roma.js");
    const userIds = results.filter((r) => r.node.metadata.kind === "userID");
    assert.ok(
      userIds.some((r) => (r.node.metadata.value as string).startsWith("USER_")),
      "应包含 USER_ 前缀的用户 ID",
    );
  });

  it("检测 roma.js 中的部门 ID（HZ 前缀）", () => {
    const results = extractHardcoded(ROMA_JS, "roma.js");
    const deptIds = results.filter((r) => r.node.metadata.kind === "deptID");
    assert.ok(
      deptIds.some((r) => (r.node.metadata.value as string).startsWith("HZ")),
      "应包含 HZ 前缀的部门 ID",
    );
  });

  it("检测 roma.js 中的字典 ID", () => {
    const results = extractHardcoded(ROMA_JS, "roma.js");
    const dictIds = results.filter((r) => r.node.metadata.kind === "dictID");
    assert.ok(dictIds.length > 0, "应包含字典 ID");
  });

  it("检测 Java 中的角色 ID", () => {
    const results = extractHardcoded(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    assert.ok(results.length > 0, "Java 文件应检测到硬编码");
  });

  it("每个硬编码项都包含上下文和位置", () => {
    const results = extractHardcoded(ROMA_JS, "roma.js");
    for (const { node } of results) {
      assert.ok(node.file, "应有文件路径");
      assert.ok(node.line, "应有行号");
      assert.ok(node.metadata.context, "应有上下文代码");
      assert.ok(node.metadata.value, "应有硬编码值");
    }
  });
});

describe("extractJavaStructure", () => {
  it("提取类名、包名、方法签名", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    assert.ok(info, "应提取到类信息");
    assert.equal(info!.className, "FlowCommonServiceImpl");
    assert.equal(info!.packageName, "com.zcst.modules.flow.service.impl");
    assert.ok(info!.methods.length >= 2, `应至少有 2 个方法，实际 ${info!.methods.length}`);
    const getPersonTree = info!.methods.find((m) => m.name === "getPersonTree");
    assert.ok(getPersonTree, "应包含 getPersonTree 方法");
    assert.ok(getPersonTree!.signature.includes("List"), "签名应包含返回类型");
  });

  it("提取 Mapper 调用", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    const method = info!.methods.find((m) => m.name === "getPersonTree");
    assert.ok(
      method!.mapperCalls.some((c) => c.mapper === "flowCommonMapper"),
      "应检测到 flowCommonMapper 调用",
    );
  });

  it("提取 Service 调用", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    const method = info!.methods.find((m) => m.name === "buildCondition");
    assert.ok(
      method!.serviceCalls.some((c) => c.service === "docCommandService"),
      "应检测到 docCommandService 调用",
    );
  });

  it("提取 @Value 配置注入", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    assert.ok(info!.configInjections.length >= 2, "应有至少 2 个配置注入");
    assert.ok(
      info!.configInjections.some((c) => c.key === "roleId.CSLD"),
      "应包含 roleId.CSLD 配置",
    );
  });
});

describe("extractEndpoints", () => {
  it("提取 Controller 的 URL 映射", () => {
    const endpoints = extractEndpoints(JAVA_CONTROLLER, "DocController.java");
    assert.equal(endpoints.length, 3);
    const list = endpoints.find((e) => e.url === "/doc/list");
    assert.ok(list, "应包含 /doc/list");
    assert.equal(list!.httpMethod, "GET");
    assert.equal(list!.methodName, "list");
    const command = endpoints.find((e) => e.url === "/doc/command");
    assert.equal(command!.httpMethod, "POST");
  });
});

describe("extractFrontendApiCalls", () => {
  it("提取 utils.ajaxPOST 调用", () => {
    const calls = extractFrontendApiCalls(ROMA_JS, "roma.js");
    assert.ok(calls.length >= 2, `应有至少 2 个 API 调用，实际 ${calls.length}`);
    assert.ok(
      calls.some((c) => c.url.includes("datumRecord")),
      "应包含 datumRecord 相关 URL",
    );
    assert.ok(
      calls.some((c) => c.url.includes("dictionaries")),
      "应包含 dictionaries 相关 URL",
    );
  });
});

describe("extractSpecialCases", () => {
  it("检测特殊情况注释", () => {
    const specialSource = `
        // 如果是jiyaosw, 特殊处理一下人员返回
        function handle(data) { return data; }
        // TODO: 临时方案，后续要改成配置化
        function temp() {}
    `;
    const cases = extractSpecialCases(specialSource, "test.js");
    assert.ok(cases.length >= 2, `应至少检测到 2 个特殊情况，实际 ${cases.length}`);
    assert.ok(
      cases.some((c) => c.kind === "special" && c.description.includes("特殊处理")),
      "应检测到「特殊处理」注释",
    );
    assert.ok(
      cases.some((c) => c.kind === "todo" || c.kind === "temp"),
      "应检测到 TODO 或临时",
    );
  });
});

describe("buildGraphFromClass", () => {
  it("生成类→方法的 CONTAINS 边", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    const { nodes, edges } = buildGraphFromClass(info!);
    assert.ok(nodes.some((n) => n.type === "class" && n.name === "FlowCommonServiceImpl"));
    assert.ok(nodes.some((n) => n.type === "method" && n.name === "getPersonTree"));
    assert.ok(edges.some((e) => e.type === "CONTAINS"));
  });

  it("生成方法间的 CALLS 边", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    const { edges } = buildGraphFromClass(info!);
    assert.ok(edges.some((e) => e.type === "CALLS"), "应有 CALLS 边");
  });

  it("生成 DEPENDS_ON_CONFIG 边", () => {
    const info = extractJavaStructure(JAVA_SERVICE, "FlowCommonServiceImpl.java");
    const { edges } = buildGraphFromClass(info!);
    assert.ok(
      edges.some((e) => e.type === "DEPENDS_ON_CONFIG"),
      "应有 DEPENDS_ON_CONFIG 边",
    );
  });
});
