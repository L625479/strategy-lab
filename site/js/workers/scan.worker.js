// Web Worker: 把當沖掃描放在背景執行緒,頁面在掃描時不會卡住。協定: { id, method, args } → { id, progress } * → { id, result } | { id, error }
import { createService } from '../engine/dtService.js';

const service = createService();

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    if (!Object.hasOwn(service, method)) throw new Error(`未知的方法 ${method}`);
    const result = await service[method](args, (done, total) => self.postMessage({ id, progress: { done, total } }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
