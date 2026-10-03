/** WS 初始化只需step编号；完成载荷保留在发送路径，不随长连接累计。 */
export function selectInitialHistoryStepIndices(
  steps: readonly { idx: number }[],
  activeStep: number | null,
  announcedSteps: ReadonlyMap<number, boolean>,
): number[] {
  return steps
    .filter((step) => step.idx !== activeStep && !announcedSteps.has(step.idx))
    .map((step) => step.idx);
}
