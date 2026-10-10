export type ToolActivationDecision =
  | { additions: string[]; error: null }
  | { additions: []; error: string };

/** 验证按需激活请求，并只返回空间允许且尚未提供的工具。 */
export function resolveToolActivation(
  requested: unknown,
  allowedTools: readonly string[],
  initialTools: readonly string[],
  activeTools: ReadonlySet<string>,
): ToolActivationDecision {
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== 'string')) {
    return { additions: [], error: '按需工具请求格式无效。' };
  }
  const names = [...new Set(requested as string[])];
  const allowed = new Set(allowedTools);
  const invalid = names.find((name) => !allowed.has(name));
  if (invalid) return { additions: [], error: `工具未获当前空间授权：${invalid}` };
  return {
    additions: names.filter((name) => !initialTools.includes(name) && !activeTools.has(name)),
    error: null,
  };
}
