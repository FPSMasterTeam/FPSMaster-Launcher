# 更新日志写法规范

## 更新日志会出现在哪里

同一份文本会同时出现在这三处，所以它是**给玩家看的**，不是给开发者看的：

- 启动器「必须更新」页（`tauri-app/src/pages/MandatoryUpdate.tsx`）
- 设置 → 关于 → 启动器更新（`tauri-app/src/pages/Settings.tsx`）
- GitHub Release 正文，以及后端 `GET /api/v1/launcher/app-update` 返回的 `notes`

## 它是从哪来的

`.github/workflows/ci-release.yml` 只在 `v*` 语义化版本 tag 上发版，changelog 直接取被打 tag 的那个 commit 的完整提交信息：

```bash
changelog="$(git log -1 --pretty=format:'%s%n%n%b')"
```

**所以：打 tag 的那个 commit 的提交信息，就是用户看到的更新日志。** 发版前先把这个 commit 的 message 写好（通常就是版本号 bump 的那个 commit），不要指望之后再改——已经登记到后端的 changelog 不会随 commit 改写而更新。

## 写法要求

1. **用中文写。** 面向玩家，不是面向开发者。
2. **只写有明显感知的变更。** 新功能、界面/交互改动、影响正常使用的修复、明显的性能变化。
3. **不写实现细节。** 文件名、函数名、组件名、CSS 类、重构、依赖升级、日志与埋点、内部 API 调整，一律不写。
4. **小修小补合并成一条。** 多个 bug 修复、多个小优化合并为「修复若干已知问题并优化使用体验」这样的一条即可。
5. **控制在 6 条以内，一条一行，`- ` 开头。** 更新页默认只展示约 5 行，其余折叠到「展开完整更新日志」里；写太长玩家根本不会展开。
6. **首行是标题**，格式 `vX.Y.Z 更新`，然后空一行再写条目。

## 模板

```
v0.3.15 更新

- 新增 XXX
- 首页/设置页界面重做，操作更直观
- 修复 XXX 导致无法启动游戏的问题
- 修复若干已知问题并优化使用体验
```

## 对照例子

不要这样写（实现细节、英文、太碎）：

```
feat(ui): v0.3.14 — native macOS chrome, UI overhaul, Nova repair-state fix

- macOS: native decorations via tauri.macos.conf.json (Overlay title bar,
  hidden title, traffic lights aligned to the 40px app bar); platform-aware
  window controls in WindowTitleBar/TitleBar
- Slim app title bar with version chip; rounded/dimmed surface tokens
- Light theme: dimmed neutral slate palette, dark-tint overlays, accent
  text on active chips; base-layer button reset so Tailwind utilities apply
- Fix: Nova stuck on "needs repair" — only the fabric.mod.json-declared
  access widener decides runtime support
- Platform detection prefers navigator.platform (WebKitGTK UA can lie)
```

应该这样写：

```
v0.3.14 更新

- macOS 版改用系统原生窗口，标题栏与红绿灯按钮对齐
- 启动器界面整体重做：首页更紧凑，设置改为分页
- 浅色主题配色重新调校，对比度更舒适
- 修复 Nova 一直提示「需要修复」的问题
- 修复若干已知问题并优化使用体验
```
