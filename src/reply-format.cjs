'use strict';

// String.raw keeps the examples literal: these are instructions about escaping,
// not control characters to embed in the prompt itself.
const REPLY_FORMAT = String.raw`公式输出要求：text 中行内公式使用 $...$，独立公式使用单独成行、前后配对的 $$，不要把公式放进代码块。最终 JSON 字符串内的每个 LaTeX 反斜杠必须正确转义：例如 Markdown 中的 \mathbf、\frac、\beta、\int 在 JSON 原文中应写成 \\mathbf、\\frac、\\beta、\\int；公式换行命令的两个反斜杠在 JSON 中写成四个反斜杠。禁止输出 U+0000 等异常控制字符，也不要把 LaTeX 命令误写成 JSON 的 \b、\f、\t、\r、\n 转义。提交前检查 JSON 解码后的 text：LaTeX 反斜杠、花括号、公式分隔符完整，且没有空字符、退格或换页符；发现问题先修正再输出。`;

module.exports = { REPLY_FORMAT };
