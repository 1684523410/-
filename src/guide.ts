// Built-in usage guide for AI clients, plus project rule discovery.
import * as fs from "node:fs";
import * as path from "node:path";

export const RULE_FILES = [".lingo/rules.md", "AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", ".cursorrules"];

export function readProjectRules(root: string, max = 12000): { file: string; text: string } | undefined {
  for (const f of RULE_FILES) {
    const p = path.join(root, f);
    try {
      if (fs.statSync(p).isFile()) {
        let t = fs.readFileSync(p, "utf8");
        if (t.length > max) t = t.slice(0, max) + "\n…[规则文件过长，已截断]";
        return { file: f, text: t };
      }
    } catch { /* not found */ }
  }
  return undefined;
}

export function shortInstructions(root: string, opts: { allowWrite: boolean; allowCommand: boolean }) {
  const win = process.platform === "win32";
  const rules = readProjectRules(root);
  return [
    `你通过「灵桥 Lingo Bridge」连接到用户本地电脑上的 VS Code 工作区。根目录: ${root}；系统: ${win ? "Windows" : process.platform}；命令行: ${win ? "PowerShell（用 ; 分隔命令，不要用 &&；路径用反斜杠或引号包起来）" : "bash"}。`,
    `开始任何任务前，先调用 get_usage_guide 读一遍完整使用说明（只需一次）。所有路径都相对于工作区根目录，不能访问根目录之外。`,
    `权限：写文件${opts.allowWrite ? "已开启" : "已关闭"}，运行命令${opts.allowCommand ? "已开启" : "已关闭"}。用户可能会在 VS Code 里弹窗审批你的操作，被拒绝时不要重复尝试，换个方式或询问用户。`,
    rules ? `本项目有规则文件 ${rules.file}，必须遵守，内容如下：\n${rules.text}` : `本项目没有规则文件（可建议用户运行“灵桥: 创建项目规则文件”）。`,
  ].join("\n");
}

export function fullGuide(root: string, opts: { allowWrite: boolean; allowCommand: boolean }) {
  const win = process.platform === "win32";
  const rules = readProjectRules(root);
  return `# 灵桥 Lingo Bridge 使用说明（给 AI 看）

## 环境
- 工作区根目录：${root}
- 系统：${win ? "Windows" : process.platform}
- run_command 使用：${win ? "Windows PowerShell 5.1。多条命令用 `;` 分隔（不支持 `&&`）；环境变量写 `$env:NAME`；输出已设为 UTF-8。" : "bash -lc"}
- 写文件：${opts.allowWrite ? "允许" : "禁止"}；运行命令：${opts.allowCommand ? "允许" : "禁止"}

## 推荐工作流程
1. **了解项目**：get_workspace_info（概况、项目类型、git 分支）→ list_directory / find_files → search_text 定位代码 → read_files 一次读多个相关文件。
2. **先计划再动手**：改动较大时，先用一两句话告诉用户你准备怎么改，再执行。
3. **修改代码**：小改动用 edit_file（old_text 必须与原文完全一致且唯一，先 read_file 确认）；新建或整体重写用 write_file。不要为了改一行而重写整个文件。
4. **验证**：改完用 get_diagnostics（若有）看编辑器报错；需要时 run_command 跑构建/测试（如 npm test、python -m pytest）。
5. **汇报**：长任务每完成一个阶段调用 report_progress；结束时用 open_in_editor 打开最关键的文件给用户看，并总结改了哪些文件。

## 规则
- 只在工作区内操作；不要删除或移动用户没让你动的文件；delete_path 前先确认。
- 不要运行破坏性命令（格式化磁盘、rm -rf /、git push --force、git reset --hard 等），除非用户明确要求。
- 长时间运行的程序（开发服务器、监听进程）用 run_command 的 background=true。
- 安装依赖前告诉用户；国内网络下 npm/pip 可能较慢，可建议镜像（npm --registry=https://registry.npmmirror.com，pip -i https://pypi.tuna.tsinghua.edu.cn/simple）。
- 读大文件时用 start_line / end_line 分段读，避免截断。
- 回复用户时使用中文（除非用户用其他语言）。

## 工具一览
- get_usage_guide：本说明
- get_workspace_info：工作区概况
- list_directory / find_files / search_text：浏览与搜索
- read_file / read_files：读文件（带行号）
- write_file / edit_file / delete_path / move_path：修改
- write_binary_file：写入图片等二进制文件（base64，可分段追加）
- run_command：运行命令
- get_diagnostics：编辑器错误和警告（仅 VS Code 版有；灵桥小球版请用 run_command 跑编译/检查命令）
- open_in_editor：在用户的 VS Code 打开文件
- report_progress：在 VS Code 里显示进度

## 项目规则
${rules ? `来自 ${rules.file}（必须遵守）：\n\n${rules.text}` : "本项目暂无规则文件。用户可在 VS Code 运行“灵桥: 创建项目规则文件”生成 .lingo/rules.md。"}
`;
}

export const RULES_TEMPLATE = `# 项目规则（给接入灵桥的 AI 看）

> 灵桥会把这个文件自动发给每一个接入的 AI。按你的项目改写下面的内容。

## 项目简介
- 这是一个 ……（一句话说明项目是做什么的）
- 技术栈：……

## 常用命令
- 安装依赖：……
- 运行：……
- 测试：……

## 代码约定
- 代码风格：……
- 不要修改的目录/文件：……

## 其他要求
- 回复用中文
- 改动前先说明计划
`;
