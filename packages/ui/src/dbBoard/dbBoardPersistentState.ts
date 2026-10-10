import { useCallback, useSyncExternalStore } from "react";

/**
 * 跨组件卸载保留的模块级状态（键自带命名空间）。
 *
 * 用途：探索看板的生成/修订进度与每图运行态在切 tab、切主视图（组件卸载）后仍需延续——
 * 服务端事实（看板定义）本就持久化，这里只保留未保存的生成进度与图表运行态，不落盘
 * （刷新页面即重置，与「运行态不持久化」的既有口径一致）。
 *
 * 注意：initial 必须在首次渲染时播种进 store（引用稳定），否则 getSnapshot 每次返回
 * 新字面量会触发无限重渲染。
 */
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  if (!values.has(key)) {
    values.set(key, initial);
  }
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => values.get(key) as T,
    () => initial,
  );
  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = values.get(key) as T;
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      values.set(key, resolved);
      emit(key);
    },
    [key],
  );
  return [value, setValue];
}
