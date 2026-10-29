// 暫時的診斷: Yahoo 的搜尋 API 對中文字會回 400,試幾種參數組合(查完就刪)
const UA = 'Mozilla/5.0 (strategy-lab data fetch)';
const base = 'https://query2.finance.yahoo.com/v1/finance/search';
const tries = [
  ['台積電', { quotesCount: '10', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' }],
  ['台積電', { quotesCount: '10', newsCount: '0' }],
  ['台積電', { quotesCount: '10', newsCount: '0', lang: 'zh-Hant-TW', region: 'TW' }],
  ['台積電', { quotesCount: '10', newsCount: '0', lang: 'zh-TW', region: 'TW' }],
  ['台積電', { quotesCount: '10', newsCount: '0', lang: 'en-US', region: 'US' }],
  ['台積電', {}],
  ['鴻海', { quotesCount: '10', newsCount: '0', lang: 'zh-Hant-TW', region: 'TW' }],
  ['騰訊', { quotesCount: '10', newsCount: '0', lang: 'zh-Hant-HK', region: 'HK' }],
  ['tsmc', { quotesCount: '10', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' }],
  ['2330', { quotesCount: '10', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' }],
  ['taiwan semiconductor', { quotesCount: '10', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' }],
  ['2330.TW', { quotesCount: '10', newsCount: '0' }],
];
for (const [q, extra] of tries) {
  for (const host of ['query2', 'query1']) {
    const u = new URL(base.replace('query2', host)); u.searchParams.set('q', q); for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      const t = await r.text();
      let syms = '';
      try { syms = JSON.stringify((JSON.parse(t).quotes || []).map((x) => `${x.symbol}:${x.quoteType}:${x.shortname || x.longname}`).slice(0, 5)); } catch { syms = t.slice(0, 120); }
      console.log(`${r.status} ${host} q=${q} ${JSON.stringify(extra)} → ${syms}`);
    } catch (e) { console.log(`ERR ${host} q=${q}: ${e.message}`); }
  }
}
