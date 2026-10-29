// 呼叫當沖服務。優先用 Web Worker(掃描不會卡住頁面);瀏覽器不支援 module worker 時退回主執行緒直接執行。

import { createService } from '../engine/dtService.js';

export function createRunner() {
  let worker = null, broken = false, seq = 1, inline = null;
  const pending = new Map();

  function ensureWorker() {
    if (worker || broken) return worker;
    try {
      worker = new Worker(new URL('../workers/scan.worker.js', import.meta.url), { type: 'module' });
    } catch { broken = true; return null; }
    worker.onmessage = (e) => {
      const { id, progress, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (progress) { p.onProgress?.(progress.done, progress.total); return; }
      pending.delete(id);
      if (error !== undefined) p.reject(new Error(error)); else p.resolve(result);
    };
    worker.onerror = () => {                                   // 載不進來(不支援 module worker、被擋下…)
      broken = true; worker = null;
      for (const p of pending.values()) p.reject(Object.assign(new Error('worker 無法啟動'), { workerBroken: true }));
      pending.clear();
    };
    return worker;
  }

  const viaWorker = (method, args, onProgress, transfer) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, method, args }, transfer);
  });

  return {
    /** 呼叫服務的方法。transfer: 要轉移所有權的 ArrayBuffer(只在 Worker 模式下使用,例如 .npz 檔案內容)。 */
    async call(method, args, { onProgress, transfer = [] } = {}) {
      if (ensureWorker()) {
        try { return await viaWorker(method, args, onProgress, transfer); } catch (err) { if (!err.workerBroken) throw err; }
      }
      inline ||= createService();
      await new Promise((r) => setTimeout(r, 0));              // 讓畫面先更新「執行中」
      return inline[method](args, onProgress);
    },
    get mode() { return broken || !worker ? 'inline' : 'worker'; },
  };
}
