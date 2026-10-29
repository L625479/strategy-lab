// 規則語法: 接近 Pine 的表達式,例如  cross_above(ema_f, ema_s) and rsi < 70 and close > sma(close, 200)[1]
// 自己寫的遞迴下降解析器 + 逐元素求值,完全不使用 eval / new Function,使用者輸入無法執行任意程式碼。

export class ExprError extends Error {
  constructor(message, pos = null) {
    super(message);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
const MAX_LENGTH = 500;
const MAX_DEPTH = 60;

export function tokenize(src) {
  if (typeof src !== 'string') throw new ExprError('規則必須是文字');
  if (src.length > MAX_LENGTH) throw new ExprError(`規則太長(上限 ${MAX_LENGTH} 字元)`);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      tokens.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const word = m[0];
      tokens.push(KEYWORDS.has(word) ? { type: 'kw', value: word, pos: i } : { type: 'id', value: word, pos: i });
      i += word.length;
    } else if ((m = /^(<=|>=|==|!=|&&|\|\||[<>+\-*/%()[\],!])/.exec(rest))) {
      tokens.push({ type: 'op', value: m[0], pos: i });
      i += m[0].length;
    } else if (ch === '=') {
      throw new ExprError('單一個 = 不是比較,請用 ==', i);
    } else {
      throw new ExprError(`不認得的符號「${ch}」`, i);
    }
  }
  return tokens;
}

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; this.depth = 0; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  isOp(v) { const k = this.peek(); return k && k.type === 'op' && k.value === v; }
  isWord(...words) { const k = this.peek(); return k && k.type === 'kw' && words.includes(k.value); }
  expectOp(v, hint) {
    const k = this.next();
    if (!k || k.type !== 'op' || k.value !== v) throw new ExprError(hint || `缺少「${v}」`, k ? k.pos : null);
  }
  enter() { if (++this.depth > MAX_DEPTH) throw new ExprError('括號或運算巢狀太深'); }
  leave() { this.depth--; }

  parse() {
    if (!this.t.length) throw new ExprError('規則是空的');
    const ast = this.parseOr();
    const extra = this.peek();
    if (extra) throw new ExprError(`多餘的內容「${extra.value}」(是否漏了 and / or ?)`, extra.pos);
    return ast;
  }
  parseOr() {
    this.enter();
    let left = this.parseAnd();
    while (this.isWord('or') || this.isOp('||')) { this.next(); left = { t: 'or', l: left, r: this.parseAnd() }; }
    this.leave();
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (this.isWord('and') || this.isOp('&&')) { this.next(); left = { t: 'and', l: left, r: this.parseNot() }; }
    return left;
  }
  parseNot() {
    if (this.isWord('not') || this.isOp('!')) { this.next(); this.enter(); const e = this.parseNot(); this.leave(); return { t: 'not', e }; }
    return this.parseCmp();
  }
  parseCmp() {
    const terms = [this.parseAdd()], ops = [];
    while (['<', '<=', '>', '>=', '==', '!='].some((o) => this.isOp(o))) {
      ops.push(this.next().value);
      terms.push(this.parseAdd());
    }
    return ops.length ? { t: 'cmp', ops, terms } : terms[0];
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().value; left = { t: 'bin', op, l: left, r: this.parseMul() }; }
    return left;
  }
  parseMul() {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.next().value; left = { t: 'bin', op, l: left, r: this.parseUnary() }; }
    return left;
  }
  parseUnary() {
    if (this.isOp('-') || this.isOp('+')) { const op = this.next().value; this.enter(); const e = this.parseUnary(); this.leave(); return { t: 'un', op, e }; }
    return this.parsePostfix();
  }
  parsePostfix() {
    let e = this.parsePrimary();
    while (this.isOp('[')) {
      const open = this.next();
      const k = this.next();
      if (!k || k.type !== 'num' || !Number.isInteger(k.value) || k.value < 0) {
        throw new ExprError('[ ] 內必須是 0 以上的整數(例如 close[1]);負數會看到未來,不允許', k ? k.pos : open.pos);
      }
      this.expectOp(']');
      e = { t: 'idx', e, k: k.value };
    }
    return e;
  }
  parsePrimary() {
    const k = this.next();
    if (!k) throw new ExprError('規則在這裡突然結束,少了一個值');
    if (k.type === 'num') return { t: 'num', v: k.value };
    if (k.type === 'kw' && (k.value === 'true' || k.value === 'false')) return { t: 'bool', v: k.value === 'true' };
    if (k.type === 'id') {
      if (this.isOp('(')) {
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          do { args.push(this.parseOr()); } while (this.isOp(',') && this.next());
        }
        this.expectOp(')', `函式 ${k.value}( 缺少結尾的「)」`);
        return { t: 'call', f: k.value, args, pos: k.pos };
      }
      return { t: 'name', n: k.value, pos: k.pos };
    }
    if (k.type === 'op' && k.value === '(') {
      this.enter();
      const e = this.parseOr();
      this.leave();
      this.expectOp(')', '括號沒有成對,缺少「)」');
      return e;
    }
    throw new ExprError(`這裡不該出現「${k.value}」`, k.pos);
  }
}

export function parse(src) {
  return new Parser(tokenize(src)).parse();
}

/** 掃描 AST,回傳用到的名稱與函式 */
export function analyze(ast) {
  const names = new Set(), calls = new Map();
  (function walk(n) {
    switch (n.t) {
      case 'name': names.add(n.n); break;
      case 'call': calls.set(n.f, n.args.length); n.args.forEach(walk); break;
      case 'idx': case 'not': case 'un': walk(n.e); break;
      case 'bin': case 'and': case 'or': walk(n.l); walk(n.r); break;
      case 'cmp': n.terms.forEach(walk); break;
      default: break;
    }
  })(ast);
  return { names, calls };
}

// ---- 求值 ----------------------------------------------------------------

const isNum = (x) => typeof x === 'number';
const truthy = (v) => (v !== v ? 0 : (v !== 0 ? 1 : 0)); // NaN 視為 false

function map1(x, f) {
  if (isNum(x)) return f(x);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = f(x[i]);
  return out;
}

function map2(a, b, f) {
  if (isNum(a) && isNum(b)) return f(a, b);
  const n = isNum(a) ? b.length : a.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(isNum(a) ? a : a[i], isNum(b) ? b : b[i]);
  return out;
}

const ARITH = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
};
const CMP = {
  '<': (a, b) => (a < b ? 1 : 0), '<=': (a, b) => (a <= b ? 1 : 0), '>': (a, b) => (a > b ? 1 : 0),
  '>=': (a, b) => (a >= b ? 1 : 0), '==': (a, b) => (a === b ? 1 : 0), '!=': (a, b) => (a !== b && a === a && b === b ? 1 : 0),
};

/**
 * ctx = { env: {名稱: 數字|序列}, funcs: makeFunctions(...) 的結果 }
 * 回傳數字或 Float64Array;布林結果用 1 / 0 表示。
 */
export function evaluate(ast, ctx) {
  const ev = (n) => evaluate(n, ctx);
  switch (ast.t) {
    case 'num': return ast.v;
    case 'bool': return ast.v ? 1 : 0;
    case 'name':
      if (!Object.hasOwn(ctx.env, ast.n)) throw new ExprError(`不認得的名稱「${ast.n}」`, ast.pos);
      return ctx.env[ast.n];
    case 'un': { const v = ev(ast.e); return ast.op === '-' ? map1(v, (x) => -x) : v; }
    case 'bin': return map2(ev(ast.l), ev(ast.r), ARITH[ast.op]);
    case 'not': return map1(ev(ast.e), (x) => (truthy(x) ? 0 : 1));
    case 'and': return map2(ev(ast.l), ev(ast.r), (a, b) => (truthy(a) && truthy(b) ? 1 : 0));
    case 'or': return map2(ev(ast.l), ev(ast.r), (a, b) => (truthy(a) || truthy(b) ? 1 : 0));
    case 'cmp': {
      const vals = ast.terms.map(ev);
      let result = map2(vals[0], vals[1], CMP[ast.ops[0]]);
      for (let k = 1; k < ast.ops.length; k++) {
        const next = map2(vals[k], vals[k + 1], CMP[ast.ops[k]]);
        result = map2(result, next, (a, b) => (a && b ? 1 : 0));
      }
      return result;
    }
    case 'idx': {
      const v = ev(ast.e);
      if (isNum(v)) return v;
      const out = new Float64Array(v.length).fill(NaN);
      for (let i = ast.k; i < v.length; i++) out[i] = v[i - ast.k];
      return out;
    }
    case 'call': {
      if (!Object.hasOwn(ctx.funcs, ast.f)) throw new ExprError(`不認得的函式「${ast.f}」`, ast.pos);
      const def = ctx.funcs[ast.f], n = ast.args.length;
      if (n < def.min || n > def.max) {
        const want = def.min === def.max ? `${def.min}` : `${def.min}~${def.max}`;
        throw new ExprError(`函式 ${ast.f} 需要 ${want} 個參數,收到 ${n} 個`, ast.pos);
      }
      const args = ast.args.map(ev);
      const firstSeries = def.series === 'all' ? Infinity : (def.series === 'first' ? 1 : 0);
      args.forEach((a, k) => {
        if (!isNum(a) && k >= firstSeries) {
          throw new ExprError(`函式 ${ast.f} 的第 ${k + 1} 個參數必須是數字(例如週期),不能是價格或指標序列`, ast.pos);
        }
      });
      return def.fn(...args);
    }
    default: throw new ExprError('內部錯誤: 未知的語法節點');
  }
}

/** 求值結果轉成長度 n 的 Float64Array(純量會展開) */
export function asSeries(v, n) {
  return isNum(v) ? new Float64Array(n).fill(v) : v;
}

/** 求值結果轉成 0/1 的 Uint8Array;NaN 一律 0 */
export function asSignal(v, n) {
  const out = new Uint8Array(n);
  if (isNum(v)) { out.fill(truthy(v)); return out; }
  for (let i = 0; i < n; i++) out[i] = truthy(v[i]);
  return out;
}
