# Preview 身份安装包的系统级隔离（shell 集成层）

## 产品规则

- Preview 包（构建期 `ZCODE_PREVIEW_IDENTITY=1`，产品名 `ZCode Preview`）的定位是与正式版
  ZCode 并排安装。安装目录、appId、Electron userData、托盘 AUMID 已按身份隔离；本 spec
  补齐 shell 集成层的隔离，并满足“不创建任何快捷方式、不添加右键菜单”的发布要求。
- Preview 包在安装、运行、卸载全生命周期内不得：
  1. 创建桌面 / 开始菜单快捷方式（包括更新时的 .lnk 修复）；
  2. 注册 `zcode://` 协议——scheme 固定为 `zcode`，谁注册谁抢占正式版的 deep link；
  3. 写入 Windows Explorer「在ZCode中打开」右键菜单注册表项
     （`HKCU\Software\Classes\{Directory,Drive}\shell\ZCode.OpenInZCode`）。
- 正式版（production flavor）打包与运行行为保持不变。

## 状态所有者

- `zcode://` 协议注册与右键菜单注册表项的唯一所有者是正式版安装包/应用；
  Preview 包对两者只读（不写、不删）。
- 快捷方式唯一所有者是正式版安装包；Preview 安装/更新/卸载均不创建、不修复 `.lnk`。

## 接口

- 构建期身份解析：`packages/desktop/scripts/desktop-product-identity.mjs`
  （flavor = preview | production，electron-builder 配置与 tsup/vite 编译期 define 共用）。
- electron-builder 配置（`packages/desktop/electron-builder.config.js`）按 flavor 裁剪：
  - `nsis.createDesktopShortcut: false` / `nsis.createStartMenuShortcut: false`：
    electron-builder 据此注入 `DO_NOT_CREATE_*_SHORTCUT`，上游 `installer.nsh` 与本仓库
    `build/installer.nsh` 的快捷方式创建/修复宏全部跳过；
  - `protocols: []`：NSIS 不写协议注册，卸载器也不会删除协议键
    （Windows 协议注册实际由运行时 `setAsDefaultProtocolClient` 写入，此配置影响 macOS Info.plist）；
  - `build/installer.nsh`：快捷方式创建/修复宏依赖的 `ZCodeReadShortcutTarget` 用
    `ZCODE_ANY_SHORTCUT_CREATION_ENABLED` 伞形开关守卫——两个 `DO_NOT_CREATE_*_SHORTCUT`
    同时存在时函数失去引用，NSIS /WX 会把 6010 未引用告警当错误中断打包。
- 运行期以编译期 `ZCODE_PRODUCT_FLAVOR` 为闸门：
  - `registerDeepLinkProtocol`（`src/main/index.ts`）：preview 跳过；
  - `installWindowsOpenFolderContextMenu`（`src/main/desktopWindowsOpenFolderContextMenu.ts`）：
    preview 直接返回，不执行任何 `reg.exe add`。

## 验收场景

1. `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1` 打出的 Windows 安装包：
   - 安装后桌面与开始菜单无新快捷方式；
   - `HKCU\Software\Classes\Directory|Drive\shell\ZCode.OpenInZCode` 未被新增或改写；
   - `zcode://` 默认 handler 仍指向已安装的正式版；
   - 卸载 Preview 后，正式版的协议注册与右键菜单不受影响。
2. production flavor 打包出的安装包行为与历史一致（快捷方式、协议注册、右键菜单照旧）。
