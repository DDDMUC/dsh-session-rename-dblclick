# dsh-session-rename-dblclick

双击会话标题就地改名 —— 侧边栏那一行、顶栏那一条，两处都生效。

## 用法

1. 鼠标**双击**侧边栏里的会话标题，或**双击**顶栏的会话标题；
2. 标题原地变成输入框（已全选），直接打字；
3. `Enter` 或点别处保存，`Esc` 取消；内容没改或清空则不提交。

## 它是怎么做的

- **客户端**：`document` 捕获阶段的 `dblclick` 监听，外加一层「600ms 内、8px 内
  同一条会话的两次 `click`」判定 —— 有些构建的点击处理会吃掉浏览器自己的
  双击合成，两条命中路径保证手势一定成立。命中
  `[class*="_sessionRow"] [class*="_title"]` 或 `[class*="_crumbCurrent"]` 后，
  在标题的盒子位置浮起一个 `<input>`（沿用标题自己的字体），编辑期间把标题
  设成 `visibility: hidden`，关闭时原样还原。只改可逆的样式与文本，不替换任何
  slot，也不动 React 的节点结构；模块带单例标记，重复激活不会叠出两个输入框。
- **宿主**：`POST /dsh-session-rename/rename { sessionId, title }`，仅限
  loopback + 同源请求；内部调用产品自带的 `sessionController.rename`，所以
  标题事件、侧边栏/顶栏投影都和「…」菜单里的重命名完全一致。

## 说明

- 选择器依赖 CSS Module 的**局部类名后缀**（`_sessionRow` / `_title` /
  `_crumbCurrent`），不依赖每次构建都会变的哈希前缀；产品大改结构时可能需要跟着调一次。
- 没有 host half 时，双击仍会打开输入框，但保存会提示「改名接口没有响应」。
