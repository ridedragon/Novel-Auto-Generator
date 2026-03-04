# Novel-Auto-Generator 逻辑问题分析报告

根据对 `index.js` 的代码审查，目前在暂停、恢复、停止和重置功能中存在以下逻辑缺陷：

## 1. 终止逻辑不彻底 (AI 请求无法立即停止)
### 问题描述
点击“停止”或“暂停”按钮时，正在进行的 API 请求（`fetch`）无法被立即中断。
### 核心原因
*   `callCustomApi` 函数中使用 `fetch` 发起网络请求，但没有传入 `AbortSignal`。
*   虽然代码中有 `if (abortGeneration) throw new Error('用户中止');` 的检查，但这只发生在请求开始前或重试间隔中。一旦 `fetch` 进入等待状态，脚本只能等待请求超时或完成后才能响应停止信号。
### 建议修复
*   引入 `AbortController`，在 `stopGeneration` 时调用 `abort()`。
*   将 `signal` 传递给 `fetch`。

## 2. 暂停逻辑冲突 (会导致章节跳过或报错)
### 问题描述
暂停状态在 `callCustomApi` 中会被当作错误抛出，导致重试逻辑错误介入；同时在某些等待环节（如等待 AI 回复）缺乏暂停检查。
### 核心原因
*   **异常化处理**：在 `callCustomApi` 中，`isPaused` 为真时直接抛出 Error。这被外层的 `startGeneration` 捕获后视为生成失败，触发 `retries++`。若暂停时间较长，会耗尽重试次数导致跳章。
*   **检查点缺失**：`waitForAIResponse` 等函数只检查了 `abortGeneration`（停止信号），没有检查 `isPaused`。这意味着如果 AI 正在生成时用户点击暂停，程序会执着地等完这一章并可能触发后续的“消息优化”逻辑，而不是立即原地待命。
### 建议修复
*   暂停不应该抛出错误，而应该在循环中安全地 `await` 等待 `isPaused` 变为 `false`。
*   在 `generateSingleChapter` 的各个关键环节（发送前、AI回复中、优化前）增加对 `isPaused` 的检查，并原地等待，而不是中断整个执行流。

## 3. 恢复/进度保存逻辑错误
### 问题描述
恢复后无法从准确位置开始，或者失败的章节会被跳过。
### 核心原因
*   在 `startGeneration` 循环末尾：
    ```javascript
    if (!success) settings.currentChapter = i + 1;
    ```
    这意味着如果一章生成彻底失败（达到了 `maxRetries`），程序依然会将 `currentChapter` 推进到下一章。这导致失败的章节被永久跳过。
*   `currentChapter` 的定义模糊。它既代表“已完成的章节数”，又在循环中作为起始索引。
### 建议修复
*   只有在 `success === true` 时才更新 `currentChapter`。
*   如果彻底失败，应该停止生成并提示用户，而不是默认跳过。

## 4. 状态同步问题 (UI 与逻辑不一致)
### 问题描述
点击“停止”后，UI 立即显示“已停止”，但后台脚本可能仍在运行。
### 核心原因
*   `stopGeneration` 直接设置 `settings.isRunning = false;`。
*   而 `startGeneration` 是一个异步循环，它依赖 `finally` 块来清理状态。
*   这会导致竞态条件：UI 显示已停止，但后台的 `sleep` 或某些未检查 `abort` 信号的逻辑仍在执行，甚至可能在几秒后再次更新进度或触发 `updateUI`。
### 建议修复
*   `stopGeneration` 只设置 `abortGeneration` 信号。
*   统一由 `startGeneration` 的 `finally` 块负责将 `isRunning` 设为 `false` 并更新 UI。

## 5. 提示词覆盖逻辑错误 (导致章节不一致)
### 问题描述
在启用“预设优化”或“自定义 API”时，生成的提示词会直接覆盖原始提示词模板。
### 核心原因
*   代码中执行：`settings.prompt = textToSend; $('#nag-set-prompt').val(textToSend);`
*   这导致用户的原始提示词模板（如“继续写下一章”）被 AI 生成的具体指令（如“继续写第5章，描述主角进入森林”）永久替换。下一章生成时，会基于“写第5章”的指令进行优化，导致章节序号、逻辑发生严重偏移。
### 建议修复
*   不应覆盖 `settings.prompt`，或者使用一个独立的变量存储“上一次生成的提示词”。

## 6. 重置逻辑不完整
### 问题描述
重置功能仅重置了章节计数，没有重置统计信息或清理可能残留的异步状态。
### 核心原因
*   `resetProgress` 仅仅做了数值重置，没有考虑到如果此时还有残留的异步回调（如 `onGenerationEnded`）正在排队，可能会导致不可预知的 UI 闪烁。
### 建议修复
*   重置时应确保所有相关统计变量（如 `lastOptimizedId`）也同步回退到初始状态。

## 总结
目前的逻辑存在多个根本性缺陷：
1.  **异常化处理状态**：将“暂停”视为“错误”抛出，导致重试逻辑介入。
2.  **缺乏控制力**：API 请求无法被 `AbortSignal` 中断。
3.  **破坏性更新**：生成的提示词覆盖了模板提示词。
4.  **不安全的进度管理**：失败也增加章节计数。

建议重构生成循环，引入 `AbortController`，并将暂停检测嵌入到每个异步等待点。
