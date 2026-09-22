import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DATA_TOKEN = 'fa5fd1943c7b386f172d6893dbfba10b';
const MARKET_INDICES = [
  { secid: '1.000001', code: '000001', name: '上证指数' },
  { secid: '0.399001', code: '399001', name: '深证成指' },
  { secid: '0.399006', code: '399006', name: '创业板指' },
];

const [requestPath] = process.argv.slice(2);
if (!requestPath) throw new Error('用法: eastmoney.mjs <请求.json>');
const request = JSON.parse(await readFile(resolve(requestPath), 'utf8'));
const action = request.action;
let data;
switch (action) {
  case 'search': data = await search(String(request.query ?? '')); break;
  case 'quote': data = await quote(await resolveSecid(request.code)); break;
  case 'intraday': data = await intraday(await resolveSecid(request.code), boundedCount(request.count, 120, 1500)); break;
  case 'kline': data = await kline(await resolveSecid(request.code), levelCode(request.level), boundedCount(request.count, 120, 500)); break;
  case 'overview': data = await Promise.all(MARKET_INDICES.map(async (item) => ({ ...item, quote: await quote(item.secid) }))); break;
  case 'collect': {
    const secid = await resolveSecid(request.code);
    const [realtime, minute, day, m30, m5] = await Promise.all([
      quote(secid), intraday(secid, 260), kline(secid, '101', 160), kline(secid, '30', 160), kline(secid, '5', 160),
    ]);
    data = { secid, realtime, intraday: minute, day, m30, m5 };
    break;
  }
  default: throw new Error('action 只能是 search、quote、intraday、kline、overview 或 collect');
}
console.log(JSON.stringify({ source: '东方财富公开行情接口', retrievedAt: new Date().toISOString(), action, data }));

async function search(query) {
  const value = query.trim();
  if (!value) throw new Error('query 不能为空');
  if (/^(?:[01]\.)?\d{5,6}$|^(?:sh|sz)\d{5,6}$/i.test(value)) {
    const secid = await resolveSecid(value);
    const current = await quote(secid);
    return [{ secid, code: current.code, name: current.name }];
  }
  const result = await getJson('https://searchapi.eastmoney.com/api/suggest/get', {
    input: value, type: '14', count: '10', token: 'D43BF722C8E33BDC906FB84D85E326E8',
  });
  return (result?.QuotationCodeTable?.Data ?? [])
    .filter((item) => item.Classify === 'AStock' && /^[01]\.\d{5,6}$/.test(item.QuoteID ?? ''))
    .map((item) => ({ secid: item.QuoteID, code: item.Code, name: item.Name }));
}

async function resolveSecid(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (/^[01]\.\d{5,6}$/.test(value)) return value;
  const code = value.replace(/^(sh|sz)/, '');
  if (!/^\d{5,6}$/.test(code)) {
    const candidates = await search(value);
    if (!candidates.length) throw new Error(`没有找到 A 股标的: ${value}`);
    return candidates[0].secid;
  }
  const markets = value.startsWith('sh') || /^[569]/.test(code) ? ['1', '0'] : ['0', '1'];
  for (const market of markets) {
    const secid = `${market}.${code}`;
    const result = await getJson('https://push2.eastmoney.com/api/qt/stock/get', { secid, fields: 'f57,f58' });
    if (result?.data?.f58) return secid;
  }
  throw new Error(`没有找到 A 股代码: ${code}`);
}

async function quote(secid) {
  const result = await getJson('https://push2.eastmoney.com/api/qt/stock/get', {
    invt: '2', fltt: '1', secid, dect: '1', ut: DATA_TOKEN,
    fields: 'f43,f44,f45,f46,f47,f48,f50,f57,f58,f59,f60,f116,f117,f127,f128,f168,f169,f170,f171',
  });
  const item = result?.data;
  if (!item) throw new Error(`实时行情不存在: ${secid}`);
  const decimal = Number(item.f59 ?? 2);
  return {
    secid, code: item.f57, name: item.f58,
    latest: scaled(item.f43, decimal), open: scaled(item.f46, decimal), high: scaled(item.f44, decimal), low: scaled(item.f45, decimal),
    previousClose: scaled(item.f60, decimal), change: scaled(item.f169, decimal), changePercent: scaled(item.f170, 2),
    amplitude: scaled(item.f171, 2), volumeRatio: scaled(item.f50, 2), turnoverRate: scaled(item.f168, 2),
    volume: numeric(item.f47), amount: numeric(item.f48), totalMarketValue: numeric(item.f116), circulatingMarketValue: numeric(item.f117),
    industry: clean(item.f127), region: clean(item.f128),
  };
}

async function intraday(secid, count) {
  const result = await getJson('https://push2his.eastmoney.com/api/qt/stock/trends2/get', {
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
    ut: DATA_TOKEN, iscr: '0', ndays: '5', secid,
  });
  return (result?.data?.trends ?? []).slice(-count).map((line) => {
    const [time, open, close, high, low, volume, amount, averagePrice] = line.split(',');
    return { time, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: Number(amount), averagePrice: Number(averagePrice) };
  });
}

async function kline(secid, level, count) {
  const result = await getJson('https://push2his.eastmoney.com/api/qt/stock/kline/get', {
    secid, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: level, fqt: '1', beg: '20200101', end: '20500101', lmt: String(Math.max(count, 120)),
  });
  return (result?.data?.klines ?? []).slice(-count).map((line) => {
    const [time, open, close, high, low, volume, amount, amplitude, changePercent, change, turnoverRate] = line.split(',');
    return { time, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: Number(amount), amplitude: Number(amplitude), changePercent: Number(changePercent), change: Number(change), turnoverRate: Number(turnoverRate) };
  });
}

async function getJson(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 RunForge/1.0', Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}`);
  return response.json();
}

function levelCode(value) {
  const levels = { m1: '1', m5: '5', m30: '30', day: '101', week: '102', month: '103' };
  const code = levels[String(value ?? 'day')];
  if (!code) throw new Error('level 只能是 m1、m5、m30、day、week 或 month');
  return code;
}

function boundedCount(value, fallback, max) {
  const count = Number.isInteger(value) ? value : fallback;
  if (count < 1 || count > max) throw new Error(`count 必须在 1 到 ${max} 之间`);
  return count;
}

function scaled(value, decimal) { return numeric(value) === null ? null : Number(value) / 10 ** decimal; }
function numeric(value) { const number = Number(value); return Number.isFinite(number) && number !== -1 ? number : null; }
function clean(value) { return typeof value === 'string' && value !== '-' ? value : ''; }
