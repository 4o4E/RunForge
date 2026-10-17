import Papa from 'papaparse';

export function parseDelimitedText(source: string, format: 'csv' | 'tsv') {
  const parsed = Papa.parse<string[]>(source, {
    delimiter: format === 'tsv' ? '\t' : ',',
    dynamicTyping: false,
  });
  // 只移除文件结束换行产生的额外空记录；空白行和引号内的空字段都是实际记录。
  const last = parsed.data.at(-1);
  if ((source.endsWith('\n') || source.endsWith('\r')) && last?.length === 1 && last[0] === '') parsed.data.pop();
  return parsed;
}
