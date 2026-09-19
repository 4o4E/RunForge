import type {
  PromptPlaceholder,
  SpaceMode,
} from '@runforge/contracts';

const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_.]*)\s*}}/g;
const ANY_PLACEHOLDER_PATTERN = /{{\s*([^{}]+?)\s*}}/g;

type PromptPlaceholderDefinition = Omit<PromptPlaceholder, 'token' | 'content'>;

const PLACEHOLDER_DEFINITIONS: PromptPlaceholderDefinition[] = [
  { key: 'workspace.root', label: '工作区路径', description: '本次运行分配的持久工作区根目录。', runtime: true },
  { key: 'sandbox.mode', label: '沙箱模式', description: '系统当前配置的工具沙箱模式。', runtime: false },
  { key: 'sandbox.backend', label: '沙箱后端', description: '系统当前配置的 shell 沙箱后端。', runtime: false },
  { key: 'shell.hostPath', label: '宿主机 PATH', description: 'shell 是否使用宿主机 PATH。', runtime: false },
  { key: 'network.mode', label: '网络模式', description: '工具运行环境是否允许网络访问。', runtime: false },
  { key: 'workflow.catalog', label: 'Workflow 目录', description: 'Workflow 使用规则和运行时可用目录。', runtime: true },
  { key: 'skills.catalog', label: 'Skill 目录', description: 'Skill 使用规则和运行时可用目录。', runtime: true },
  { key: 'mcp.catalog', label: 'MCP 目录', description: 'MCP 使用规则和当前空间可用目录。', runtime: false },
  { key: 'runtime.environment', label: '工作负载环境', description: '本次运行注入的短期令牌、资源端点和数据源摘要。', runtime: true },
  { key: 'runtime.enabledCapabilities', label: '运行资源名称', description: '当前空间允许使用的运行资源名称。', runtime: false },
  { key: 'runtime.capabilityDetails', label: '运行资源详情', description: '当前空间允许使用的模型和运行资源说明。', runtime: false },
  { key: 'external.trustedPrompt', label: '外部可信提示词', description: '外部调用方在本次请求中传入的可信提示词。', runtime: true },
];

const ALLOWED_PLACEHOLDERS = new Set(PLACEHOLDER_DEFINITIONS.map((item) => item.key));

const ROLE_PROMPT = '你是 RunForge，一个通用自主助手。';
const PLANNING_PROMPT = `- 多步骤任务要尽早调用 update_plan 写出计划，并在推进过程中刷新计划状态、记录关键决策和下一步动作。
- 真实执行失败或路径改变时，必须同步调用 update_plan；失败条目标记为 failed 并保留，不要从 plan 里删除。`;
const RUN_COMPLETION_PROMPT = `- 计划里的最后一步如果是“汇报结果/总结/最终回答”，创建计划时就把该 plan item 设置为 autoComplete=true；输出完整最终正文后，运行时会自动把这一步标记为 done。
- 最终汇报必须是没有任何工具调用的可见正文；不要把完整答案放进 reasoning/思考里，也不要在同一轮最终正文后继续调用工具。
- update_plan 只更新计划，不会结束 run；如果还没输出最终正文，先调用 update_plan 把 phase 设置为 reporting 或 completed，然后在下一轮输出无工具调用的完整最终回答。
- 一旦已经输出无工具调用的完整最终正文，不要再调用 update_plan 只为关闭计划；运行时会结束 run，未完成的计划条目会保留为状态记录。`;
const RESPONSE_STYLE_PROMPT = '- 回复要简洁；能合理假设时说明假设，不要频繁打断用户。';
const ASK_USER_PROMPT = '- 需要用户补充信息时调用 ask_user，并明确表单约束：主回答必填时设置 required=true，必须选择的选项设置 option.required=true，不要要求用户在普通输入框里回答。';
const MARKDOWN_OUTPUT_PROMPT = `- 默认使用 Markdown 输出；日常报告、表格、代码、Mermaid 图和 LaTeX 公式都直接写在 Markdown 中。
- 提到 workspace 内的文件时，必须使用 Markdown 链接语法，优先写 workspace 相对路径，例如 [server/src/agent/context.ts](server/src/agent/context.ts)。
- Mermaid 使用语言名为 "mermaid" 的 fenced code block；行内 LaTeX 公式使用 $...$，独立公式块使用 $$...$$。
- Mermaid 节点 ID 只使用英文字母、数字和下划线；节点标签包含中文、空格、符号、HTML 换行、斜杠或 @ 时必须写成 node_id["标签"]。
- 数据分析、对比、趋势、占比、流程和架构图优先用 Markdown 或 Mermaid 直接输出。`;
const HTML_ARTIFACT_PROMPT = `- 仅在 Mermaid 或 Markdown 无法表达的图型、用户明确要求交互或独立页面，或需要筛选、排序、缩放、钻取等控件时，才生成 HTML artifact。
- 使用 shell 或文件写入工具在 workspace 下创建完整的 .html/.htm 文件，优先放在 artifacts/<描述性名称>.html；不要把完整 HTML 文档放进工具调用参数。
- 创建 artifact 后，最终回答必须用 Markdown 链接语法说明产物路径。
- 除非用户明确要求原始 JSON，否则不要把界面写成声明式 JSON 或组件树。`;
const DATABASE_ACCESS_PROMPT = '- 涉及数据库、数据源、schema、库表、字段或数据统计时，必须先激活 database-access skill；不要使用宿主进程 DATABASE_URL、长期密码或服务端私密环境变量。';
const EXTERNAL_MODE_PROMPT = '当前 run 来自 external 空间：不能向 Web 用户提问或进入 waiting_for_user；信息不足时采用合理假设，或在最终结果中明确说明缺失信息。';
const WORKSPACE_RUNTIME_PROMPT = `运行时文件系统上下文:
- 持久工作区根目录: {{workspace.root}}
- 请把这个目录视为本次 run 当前可用目录。clone 仓库、创建报告、写入任何需要保留的文件，都必须放在这个目录下。
- 不要把需要保留的文件写到 /home/user、/tmp、应用仓库根目录或 workspace 之外的路径，除非用户明确要求且工具策略允许。
- Python 依赖必须安装在虚拟环境中；优先在工作区创建 .venv 并使用 uv 管理依赖，不要全局安装 pip 包。
- 工具沙箱: {{sandbox.mode}}；shell 后端: {{sandbox.backend}}；shell 使用宿主机 PATH: {{shell.hostPath}}；网络: {{network.mode}}。
- shell 是托管资源：优先用 shell_session_reuse/open 获取 session，再用 shell_exec 执行命令；短命令用 wait=foreground，长命令用 wait=background 后用 shell_poll 观察，必要时用 shell_kill 终止。
- shell session 会长期记住当前目录；需要切换目录时直接执行 cd。`;
const RUNTIME_RESOURCES_PROMPT = `运行时内部能力:
- WORKLOAD_TOKEN 是本次 run 的短期能力令牌；只能在脚本或程序代码里作为 Authorization Bearer 使用，不要输出、记录日志或写入仓库文件。
- RUNFORGE_WORKLOAD_SDK 指向 RunForge 注入的统一 SDK；业务脚本可以动态 import 该入口，不需要在插件目录安装 RunForge 依赖。
- secrets.get(key) 按 key 读取当前 tenant 配置值；插件声明用于管理员配置和缺失提示，不构成插件级 Secret 权限。Secret 只能在脚本内部使用，不能输出到模型上下文、日志或文件。
- SDK 的 resources.acquire 只负责换取短期数据库凭证和内部代理端点配置，不封装 chat、image 或 video 调用。
- 调用 llm、image 或 video 代理时，使用凭证返回的 models[].id，通过请求体 model 或 modelId 选择模型；不要依赖平台内部 modelRef 或上游真实密钥。
- 已启用运行资源: {{runtime.enabledCapabilities}}
{{runtime.capabilityDetails}}`;

function promptParts(mode: SpaceMode, customPrompt = ''): string[] {
  return [
    mode === 'web' ? ROLE_PROMPT : '',
    PLANNING_PROMPT,
    RUN_COMPLETION_PROMPT,
    RESPONSE_STYLE_PROMPT,
    mode === 'web' ? ASK_USER_PROMPT : '',
    MARKDOWN_OUTPUT_PROMPT,
    HTML_ARTIFACT_PROMPT,
    DATABASE_ACCESS_PROMPT,
    customPrompt,
    mode === 'external' ? EXTERNAL_MODE_PROMPT : '',
    '{{workflow.catalog}}',
    '{{skills.catalog}}',
    '{{mcp.catalog}}',
    WORKSPACE_RUNTIME_PROMPT,
    '{{runtime.environment}}',
    RUNTIME_RESOURCES_PROMPT,
    mode === 'external' ? '可信外部调用方指令:\n{{external.trustedPrompt}}' : '',
  ].map((part) => part.trim()).filter(Boolean);
}

export function defaultPromptTemplate(mode: SpaceMode, customPrompt = ''): string {
  return promptParts(mode, customPrompt).join('\n\n');
}

export function validatePromptTemplate(value: string): string {
  const placeholders = [...value.matchAll(ANY_PLACEHOLDER_PATTERN)];
  const unknown = placeholders
    .map((match) => match[1].trim())
    .find((placeholder) => !ALLOWED_PLACEHOLDERS.has(placeholder));
  if (unknown) throw new Error(`提示词使用了未知占位符：${unknown}`);
  const remainder = value.replace(ANY_PLACEHOLDER_PATTERN, '');
  if (remainder.includes('{{') || remainder.includes('}}')) {
    throw new Error('提示词包含格式错误的占位符');
  }
  return value.trim();
}

interface RuntimeCapabilitiesPromptSettings {
  allowedCapabilities?: string[];
  llm: { enabled: boolean; models: Array<{ id: string }> };
  image: { enabled: boolean; models: Array<{ id: string }> };
  video: { enabled: boolean; models: Array<{ id: string }> };
}

export function runtimeCapabilityPromptValues(settings: RuntimeCapabilitiesPromptSettings): {
  enabledCapabilities: string;
  capabilityDetails: string;
} {
  const enabled: string[] = [];
  if (settings.allowedCapabilities?.includes('datasource.credentials')) enabled.push('datasource.credentials');
  if (settings.llm.enabled) enabled.push('llm');
  if (settings.image.enabled) enabled.push('image');
  if (settings.video.enabled) enabled.push('video');
  const details: string[] = [];
  if (settings.llm.enabled) details.push(`- LLM: 可换取 llm 能力凭证；可选模型 id: ${settings.llm.models.map((model) => model.id).join(', ') || '未配置'}。`);
  if (settings.image.enabled) details.push(`- Image: 可换取 image 能力凭证；可选模型 id: ${settings.image.models.map((model) => model.id).join(', ') || '未配置'}。`);
  if (settings.video.enabled) details.push(`- Video: 可换取 video 能力凭证；可选模型 id: ${settings.video.models.map((model) => model.id).join(', ') || '未配置'}。`);
  return {
    enabledCapabilities: enabled.join(', ') || '无',
    capabilityDetails: details.join('\n') || '- 当前空间没有启用额外运行资源。',
  };
}

export function promptPlaceholders(
  values: Readonly<Record<string, string>>,
): PromptPlaceholder[] {
  return PLACEHOLDER_DEFINITIONS.map((definition) => {
    const content = values[definition.key];
    if (content === undefined) throw new Error(`占位符缺少预览内容：${definition.key}`);
    return {
      ...definition,
      token: `{{${definition.key}}}`,
      content,
    };
  });
}

export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<string, string | null | undefined>>,
): string {
  const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  const missing = placeholders.find((placeholder) => values[placeholder] === null || values[placeholder] === undefined);
  if (missing) throw new Error(`提示词占位符缺少运行时内容：${missing}`);
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_match, placeholder: string) => values[placeholder]!.trim(),
  ).trim();
}
