import type { Tool, ToolResult } from './types.js';
import type { A2uiComponent, A2uiMessage } from '../agent/a2ui.js';

// `render_ui` 只接收声明式 A2UI 组件树，前端再用可信组件目录渲染。

const COMPONENT_TYPES = [
  'Card',
  'Column',
  'Row',
  'Stack',
  'Text',
  'Heading',
  'Badge',
  'Divider',
  'Image',
  'CodeBlock',
  'Markdown',
  'Mermaid',
  'KeyValue',
  'Table',
];
const COMPONENT_SET = new Set<string>(COMPONENT_TYPES);
const MAX_COMPONENTS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBinding(value: unknown): boolean {
  return isRecord(value) && typeof value.path === 'string' && Object.keys(value).length === 1;
}

function hasRenderableValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isBinding(value);
}

function childIds(component: A2uiComponent): string[] {
  if (Array.isArray(component.children)) return component.children.map(String);
  if (typeof component.child === 'string') return [component.child];
  return [];
}

function validateComponentShape(component: A2uiComponent): string | null {
  if (component.child !== undefined && component.children !== undefined) return `${component.id}: child 和 children 不能同时出现`;
  if (component.child !== undefined && typeof component.child !== 'string') return `${component.id}: child 必须是字符串`;
  if (component.children !== undefined && (!Array.isArray(component.children) || component.children.some((id) => typeof id !== 'string'))) {
    return `${component.id}: children 必须是字符串数组`;
  }

  switch (component.component) {
    case 'Text':
    case 'Heading':
      return hasRenderableValue(component.text) ? null : `${component.id}: ${component.component} 需要 text`;
    case 'Markdown':
      return hasRenderableValue(component.text) ? null : `${component.id}: Markdown 需要 text`;
    case 'Mermaid':
      return hasRenderableValue(component.code) || hasRenderableValue(component.text) ? null : `${component.id}: Mermaid 需要 code 或 text`;
    case 'CodeBlock':
      return hasRenderableValue(component.code) ? null : `${component.id}: CodeBlock 需要 code`;
    case 'Image':
      return hasRenderableValue(component.src) ? null : `${component.id}: Image 需要 src`;
    case 'KeyValue':
      return Array.isArray(component.items) || isBinding(component.items) ? null : `${component.id}: KeyValue 需要 items 数组或数据绑定`;
    case 'Table':
      if (!Array.isArray(component.columns) && !isBinding(component.columns)) return `${component.id}: Table 需要 columns 数组或数据绑定`;
      if (!Array.isArray(component.rows) && !isBinding(component.rows)) return `${component.id}: Table 需要 rows 数组或数据绑定`;
      return null;
    default:
      return null;
  }
}

function validateA2ui(root: string, components: unknown[]): { ok: true; components: A2uiComponent[] } | { ok: false; error: string } {
  if (components.length > MAX_COMPONENTS) return { ok: false, error: `components 超过上限 ${MAX_COMPONENTS}` };

  const normalized: A2uiComponent[] = [];
  const byId = new Map<string, A2uiComponent>();
  for (const raw of components) {
    if (!isRecord(raw)) return { ok: false, error: '每个 component 都必须是对象' };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const component = typeof raw.component === 'string' ? raw.component.trim() : '';
    if (!id) return { ok: false, error: 'component.id 是必填字符串' };
    if (byId.has(id)) return { ok: false, error: `component.id 重复: ${id}` };
    if (!COMPONENT_SET.has(component)) return { ok: false, error: `未知组件类型: ${component || '(empty)'}` };
    const item = { ...raw, id, component } as A2uiComponent;
    const shapeError = validateComponentShape(item);
    if (shapeError) return { ok: false, error: shapeError };
    byId.set(id, item);
    normalized.push(item);
  }

  if (!byId.has(root)) return { ok: false, error: `root 不存在: ${root}` };
  for (const component of normalized) {
    for (const child of childIds(component)) {
      if (!byId.has(child)) return { ok: false, error: `${component.id} 引用了不存在的子组件: ${child}` };
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const child of childIds(byId.get(id)!)) {
      if (!walk(child)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (!walk(root)) return { ok: false, error: '组件树存在循环引用' };

  return { ok: true, components: normalized };
}

export const renderUiTool: Tool = {
  name: 'render_ui',
  description:
    '为用户渲染只读的声明式 UI。Render a rich, declarative UI surface for the user (read-only display). ' +
    '组件使用扁平 A2UI 列表并通过 id 引用，需要一个 `root`，可选 `dataModel` 用于 {"path":"/json/pointer"} 绑定。' +
    'Provide A2UI components as a flat id-referenced list with one `root`, plus optional `dataModel` bindings. ' +
    '图表统一使用 Mermaid，支持 flowchart、sequence、pie、xychart、gantt、timeline、sankey；结构化数据优先用表格、卡片和键值摘要。' +
    'Use Mermaid for diagrams and charts, and use tables/cards/key-value summaries for structured data. ' +
    `允许的组件类型 / Allowed component types: ${COMPONENT_TYPES.join(', ')}. ` +
    '示例 / Example: {"root":"c","components":[{"id":"c","component":"Card","title":"Files","child":"t"},' +
    '{"id":"t","component":"Table","columns":["name","lines"],"rows":[["a.ts","12"]]}]}. ' +
    'Mermaid 示例 / Mermaid example: {"id":"m","component":"Mermaid","code":"pie title Status\\n  \\"ok\\" : 3\\n  \\"fail\\" : 1"}.',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: '根组件 id / Id of the root component' },
      components: {
        type: 'array',
        description: '扁平 A2UI 组件列表，父子关系通过 child / children 的 id 引用。Flat list of A2UI components linked by id.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            component: { type: 'string', enum: COMPONENT_TYPES },
            code: { type: 'string', description: 'Mermaid 或 CodeBlock 使用：Mermaid DSL 或源码文本。For Mermaid/CodeBlock: Mermaid DSL or source code text.' },
            text: { description: 'Text、Markdown、Heading、Mermaid 使用：展示文本或 Mermaid DSL。For Text/Markdown/Heading/Mermaid: display text or Mermaid DSL.' },
            child: { type: 'string' },
            children: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'component'],
          additionalProperties: true,
        },
      },
      dataModel: { type: 'object', description: '可选状态对象，用于 {"path":...} 绑定。Optional state object for bindings.' },
      surfaceId: { type: 'string', description: '可选稳定 id，用于原位更新 UI。Optional stable id to update a surface in place.' },
    },
    required: ['root', 'components'],
  },
  async run(args): Promise<ToolResult> {
    const root = String(args.root ?? '');
    if (!root || !Array.isArray(args.components) || args.components.length === 0) {
      return { text: 'render_ui error: `root` and a non-empty `components` array are required.' };
    }
    const validated = validateA2ui(root, args.components);
    if (!validated.ok) {
      return { text: `render_ui error: ${validated.error}` };
    }
    const surfaceId = typeof args.surfaceId === 'string' && args.surfaceId ? args.surfaceId : `ui-${root}`;
    const message: A2uiMessage = {
      surfaceId,
      root,
      components: validated.components,
      dataModel: (args.dataModel as Record<string, unknown> | undefined) ?? undefined,
    };
    return {
      text: `UI rendered (surface ${surfaceId}, ${validated.components.length} components).`,
      display: { type: 'a2ui', surfaceId, message },
    };
  },
};
