# 1.1.8 界面验收

final result: passed

## 追加验收：上下小箭头（2026-10-18）

按用户追加要求恢复数字输入的浏览器原生上下箭头，并保持可见。只调整 `content.css` 和使用说明，没有新增 DOM、JavaScript、计时器或通信请求。版本仍为本次界面迭代的 1.1.8；下方原设计对照保留作为初版记录。

- 当前效果：[spinner-card.jpg](D:/Agent/AirCon/ui-preview/qa/spinner-card.jpg)。箭头位于数字输入右侧，点击一次增加／减少 1 分钟；原有直接输入、键盘操作、范围和禁用规则沿用。
- 内置浏览器实测两个输入框的鼠标加减：2 → 3 → 2、4 → 5 → 4。1440 时点击上箭头、1 时点击下箭头均保持原值；调节期间通信记录只有初始化，没有控制请求。
- Edge 鼠标复核 2 → 3 → 2，控制台 error／warn 为空。证据：[spinner-edge.jpg](D:/Agent/AirCon/ui-preview/qa/spinner-edge.jpg)、[spinner-edge-steps.json](D:/Agent/AirCon/ui-preview/qa/spinner-edge-steps.json)。
- 260／360／480px × 100%／200% 内容缩放共 6 组，输入 1440，箭头、四位数和单位均完整可见，无面板内溢出。为原生箭头留出位置，输入容器左右内边距由 10px 减至 7px，数字与单位间距由 6px 减至 4px。数据：[spinner-layout.json](D:/Agent/AirCon/ui-preview/qa/spinner-layout.json)；截图名 `spinner-<宽度>-zoom<1或2>.jpg`。
- 循环运行时输入及其原生箭头禁用；实际点击后值和消息数量均不变：[spinner-disabled.json](D:/Agent/AirCon/ui-preview/qa/spinner-disabled.json)。
- 修改后完整模拟测试仍为 190 项通过。未操作真实空调，也未刷新学校页面。

## 结论与修正

没有未解决的 P0／P1／P2 界面问题。验证范围是实际面板代码配合模拟后台；未重新加载真实扩展、未刷新学校标签页、未操作空调。

- 已修正 [P2] 窄栏数字焦点框：首轮输入焦点画在数字内部，形成两个边框，紧邻单位。改为在完整输入容器外显示焦点环，数字与单位均不受遮挡。证据：`ui-preview/qa/idle-260-first.jpg` → `ui-preview/qa/focus-260-final.jpg`。
- 操作按钮消失时，焦点交给仍可用的操作按钮；报告提示消失时，焦点交给“说明”。覆盖开始、停止和报告保存恢复，避免焦点落到隐藏元素。

## 视觉依据与归一化

- 用户选择的第 1 张设计：`C:/Users/Chenyy/.codex/generated_images/01a13044-16bb-7d01-9cd8-54e9d276290f/exec-31ab6e26-70ab-4979-915e-2514439da6e1.png`。
- 项目内参考副本：[reference.png](D:/Agent/AirCon/ui-preview/qa/reference.png)，1122 × 1402 像素。
- 本地实现：<http://127.0.0.1:8798/njggt/app/home>，直接加载 `edge-extension/content.js`、`content.css`、`report-format.js`；模拟 Chrome 通信与存储，未加载后台控制代码。
- 截图视口：内置浏览器 1280 × 720 CSS px；Edge 1272 × 635 CSS px。两者报告 devicePixelRatio = 2，但截图 API 输出的是 CSS 像素尺寸，没有额外乘二。
- 同状态比较：未运行、说明收起、报告就绪、输入 3／6。3／6 仅用于设计比较，由模拟页填写，没有写入实际设置。最终交付截图显示模拟保存值 2／4；生产默认仍为 10／10。
- 参考卡片裁切 `(65, 304, 1061, 1055)`，996 × 751 像素，等比例缩到 260 × 196。实现卡片实际 260 × 220 CSS px，从 1280 × 720 截图裁切到 260 × 221 像素；半像素边界向外取整。没有拉伸高度掩盖差异。
- 全图同画布对照：[comparison-final.png](D:/Agent/AirCon/ui-preview/qa/comparison-final.png)。可读细节对照：[comparison-final-focus.png](D:/Agent/AirCon/ui-preview/qa/comparison-final-focus.png)，两侧均放大二倍，顶边对齐。
- 最终含周边页面的截图：[final-preview.jpg](D:/Agent/AirCon/ui-preview/qa/final-preview.jpg)，1280 × 720；卡片裁切：[final-card.jpg](D:/Agent/AirCon/ui-preview/qa/final-card.jpg)，410 × 474。
- 全部图片尺寸：[image-sizes.json](D:/Agent/AirCon/ui-preview/qa/image-sizes.json)。长页面截图高度随内容变化，不将截图高度当作 CSS 视口高度。

## 五项视觉检查

| 检查面 | 结果 |
| --- | --- |
| 字体与层级 | 使用 Windows 可用的系统字体栈；标题 18px／600，数字 20px／500，正文 13px。没有引入字体。中英文、完整错误代码及四位数均可读；数字使用等宽数字特性。 |
| 间距与布局 | 白底、1px 灰边、12px 圆角、16px 内边距；两列输入与全宽操作区。实际窄栏保留 44px 输入／操作高度，所以卡片比归一化参考图高约 24px，属于可用性适配。 |
| 颜色 | 主色沿用 #205181；正文 #182b3c，次级文字 #596571；错误与警告分别采用红／棕色，并保留文字含义。常规状态不挤占主界面。 |
| 图片与图标 | 面板没有图片素材或自绘图标；全部是实际 HTML 控件。“说明”保留文字入口，通过 aria-expanded 和展开后的下划线表达状态；省略参考图箭头及输入内分隔线，减少窄栏装饰。参考图仅用于对照，未作为产品界面背景。 |
| 文案与内容 | “开机／关机”标题不重复写单位，每个输入旁只保留一次“分钟”。完整错误始终可见、可选择，不截断。报告就绪／保存中等常规文字收进说明；待处理问题显示短提示和入口。 |

## 浏览器验证

1. 48 组状态布局：260／360／480px × 100%／200% 内容缩放 × 未运行／开机／关机／等待／结果未知／HTTP 502／保活警告／其他页面运行。输入全部为 1440。检查可见子元素边界、内部滚动宽度、按钮状态和输入值，没有面板内溢出或值丢失。数据：[layout-matrix.json](D:/Agent/AirCon/ui-preview/qa/layout-matrix.json)；对应截图文件名为 `<状态>-<宽度>-zoom<1或2>.jpg`。
2. Edge 另外检查 6 组宽度／缩放组合，说明展开并显示保活警告，没有溢出。数据：[edge-layout.json](D:/Agent/AirCon/ui-preview/qa/edge-layout.json)；例：[edge-help-260-zoom2.jpg](D:/Agent/AirCon/ui-preview/qa/edge-help-260-zoom2.jpg)。
3. 200% 验证使用浏览器渲染的 CSS `zoom: 2`，卡片的可见宽度确认为 520／720／960px；这是内容缩放测试，未将它冒充 Edge 工具栏原生页面缩放。工具转发的浏览器缩放快捷键没有改变视口或 DPR，原生缩放未单独确认。
4. 说明默认收起；鼠标与 Enter 均可开合，不增加通信，不重建输入。报告状态更新和倒计时更新后仍展开。Edge 中倒计时变化后焦点仍在说明按钮，通信记录不变：[tick-focus.json](D:/Agent/AirCon/ui-preview/qa/tick-focus.json)。
5. 真实键盘方向键：1440 → ArrowDown → 1439 → ArrowUp → 1440。开始后焦点落在停止；停止完成后焦点回到开始。Tab 可从说明到达可用的停止按钮。
6. 结果未知时禁用开始、保留可用停止；运行时只显示停止；未运行时只显示开始；其他页面运行时保留原有操作限制。参考：[unknown-260-zoom2.jpg](D:/Agent/AirCon/ui-preview/qa/unknown-260-zoom2.jpg)、[busy-260-zoom1.jpg](D:/Agent/AirCon/ui-preview/qa/busy-260-zoom1.jpg)。
7. 报告 8 种状态分别检查：读取、就绪、保存、未授权、暂存、目录失效、写入失败、缓存失败。前 3 种仅在说明内显示；后 5 种主界面有提示。两个报告设置入口均收到各自的模拟请求，缓存失败入口展开说明。数据：[report-states.json](D:/Agent/AirCon/ui-preview/qa/report-states.json)。
8. 实际错误和保活警告独立于说明显示，报告状态变化不会覆盖它们；完整代码支持选择复制。展开的说明和报告提示在 200% 内容缩放下也没有遮挡：[help-report-260-zoom2.jpg](D:/Agent/AirCon/ui-preview/qa/help-report-260-zoom2.jpg)。
9. 最终内置浏览器及 Edge 控制台的 error／warn 日志均为空。预览服务器仅绑定 127.0.0.1，按白名单提供界面文件；CSP 禁止连接请求。真实登录记录、报告文件和控制接口没有进入预览。

## 对照迭代记录

| 轮次 | 证据 | 结论／处理 |
| --- | --- | --- |
| 1 | `comparison-first.png`、`comparison-first-focus.png`、`idle-260-first.jpg` | 白色卡片、层级、蓝色主按钮及两列布局符合方向。发现输入内部焦点框在窄栏里过于拥挤，判为 P2，暂不交付。 |
| 2 | `comparison-final.png`、`comparison-final-focus.png`、`focus-260-final.jpg` | 焦点环改到完整输入容器外，重新截图并同画布比较；没有未解决的 P0／P1／P2。字号、控件高度、单位和说明入口的差异按上表作为有意适配记录。 |
| 最终交互复核 | `edge-help-260-zoom2.jpg`、`tick-focus.json`、190 项测试 | 增加报告提示消失后的焦点交接；没有改变视觉布局，Edge 重新加载最终代码后复核。 |

## 软件检查与边界

- 完整模拟测试：190 项通过（原 171 项，加 19 项界面回归）。
- 语法检查：扩展 19 个 JS 文件和预览 2 个脚本，共 21 个通过。
- 控制器、API 客户端、报告格式、报告保存和目录模块的哈希与修改前一致；后台仅调整版本回退值。通信发送与超时、循环、两小时保活和实际报告保存规则未修改。
- 权限、依赖、设置项均未增加。预览和验收记录位于项目目录，未安装全局环境。
- 本地浏览器验收针对界面与模拟交互。真实学校页面的最终样式叠加和长期运行仍需使用者加载新版后确认；本轮没有用真实空调验证控制行为。

实施清单：面板改造、状态回归、版本与说明、浏览器截图与记录均已完成。
