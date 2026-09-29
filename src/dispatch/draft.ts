import { reactive, watch } from "vue";
import { uid } from "./engine";
import type { Fuel, ReserveInput, Station } from "./types";

/**
 * 调度草稿本地留存：
 * - 冲突时不覆盖表单，后提交者保留自己的草稿；
 * - 页面中途关闭后重开，仍能找回未派车的草稿与其所依据的版本。
 * 每个浏览器标签页使用独立槽位，避免两个调度窗口互相覆盖草稿。
 */
const DRAFTS_KEY = "hxwlfront-19-dispatch-drafts";
const TAB_ID = sessionStorage.getItem("hxwlfront-19-tab-id") ?? uid("tab");
sessionStorage.setItem("hxwlfront-19-tab-id", TAB_ID);

export interface DraftState extends ReserveInput {
  /** 草稿所依据的台账版本（版本凭据） */
  baseVersion: number;
  savedAt: string;
}

function blankDraft(baseVersion: number): DraftState {
  return {
    station: "" as Station,
    fuel: "" as Fuel,
    tons: 0,
    arriveAt: "",
    notes: "",
    baseVersion,
    savedAt: ""
  };
}

interface DraftMap {
  [tabId: string]: DraftState | undefined;
}

function readAll(): DraftMap {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    return raw ? (JSON.parse(raw) as DraftMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: DraftMap) {
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(map));
}

export function loadDraft(currentVersion: number): { draft: DraftState; restored: boolean } {
  const saved = readAll()[TAB_ID];
  if (saved && (saved.station || saved.fuel || saved.notes || saved.arriveAt)) {
    return { draft: reactive({ ...saved }), restored: true };
  }
  return { draft: reactive(blankDraft(currentVersion)), restored: false };
}

export function persistDraft(draft: DraftState) {
  const all = readAll();
  all[TAB_ID] = { ...draft, savedAt: new Date().toISOString() };
  writeAll(all);
}

export function clearDraft() {
  const all = readAll();
  delete all[TAB_ID];
  writeAll(all);
}

export function useDraftPersistence(draft: DraftState) {
  watch(
    draft,
    () => {
      if (draft.station || draft.fuel || draft.notes || draft.arriveAt || draft.tons > 0) {
        persistDraft(draft);
      }
    },
    { deep: true }
  );
}
