/**
 * 操作日志独立 tab：按表筛选（全部 / 当前选中表）+ 日志面板占满剩余高度。
 * 回退成功后由 useDbBoard 统一刷新日志与数据行（跨 tab 状态共享）。
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardOpLogPanel } from "@/dbBoard/DbBoardOpLogPanel.js";
import type { UseDbBoardState } from "@/dbBoard/useDbBoard.js";

const FILTER_ALL = "__all__";
const FILTER_CURRENT = "__current__";

export function DbBoardLogsTab({
  state,
  operator,
}: {
  state: UseDbBoardState;
  operator: string;
}) {
  const { intl } = useZCodeIntl();
  const hasSelectedTable = Boolean(state.selectedTable);
  const filterValue = state.opLogFilter ? FILTER_CURRENT : FILTER_ALL;

  return (
    <DbBoardOpLogPanel
      fillHeight
      entries={state.opLogs?.entries ?? []}
      loading={state.loadingOpLogs}
      onRefresh={() => void state.refreshOpLogs()}
      onRollback={async (logId) => state.rollback(logId, operator)}
      headerExtra={
        <Select
          value={filterValue}
          onValueChange={(value) => {
            if (value === FILTER_CURRENT && state.selectedTable) {
              state.setOpLogFilter(state.selectedTable);
            } else {
              state.setOpLogFilter(null);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>
              {intl.formatMessage({ id: "dbboard.logs.filterAll" })}
            </SelectItem>
            <SelectItem value={FILTER_CURRENT} disabled={!hasSelectedTable}>
              {state.selectedTable
                ? intl.formatMessage(
                    { id: "dbboard.logs.filterCurrent" },
                    { table: `${state.selectedTable.schema}.${state.selectedTable.name}` },
                  )
                : intl.formatMessage({ id: "dbboard.logs.filterCurrentNone" })}
            </SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}
