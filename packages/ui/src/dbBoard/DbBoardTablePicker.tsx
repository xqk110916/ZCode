/**
 * 表名选择器（Popover + Command 可筛选下拉）：
 * 已有知识卡的表显示业务域徽标，无卡表标注"无知识卡"，便于区分。
 */
import { useState } from "react";
import { ChevronsUpDown, Database } from "lucide-react";
import type { DbBoardKnowledge, DbBoardTableMeta } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DbBoardTablePicker({
  tables,
  knowledge,
  value,
  onChange,
  disabled,
}: {
  tables: readonly DbBoardTableMeta[];
  knowledge: DbBoardKnowledge | null;
  value: string;
  onChange: (table: DbBoardTableMeta) => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const selected = tables.find((table) => table.name.toLowerCase() === value.toLowerCase());
  const selectedCard = selected ? knowledge?.tables[selected.name.toLowerCase()] : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="w-full justify-between font-mono text-ui-base"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Database className="size-3.5 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 truncate">
              {selected ? selected.name : intl.formatMessage({ id: "dbboard.knowledge.pickerPlaceholder" })}
            </span>
            {selectedCard ? (
              <Badge variant="secondary" className="shrink-0">
                {selectedCard.domain}
              </Badge>
            ) : selected ? (
              <Badge variant="outline" className="shrink-0">
                {intl.formatMessage({ id: "dbboard.knowledge.noCard" })}
              </Badge>
            ) : null}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-foreground-subtle" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={intl.formatMessage({ id: "dbboard.knowledge.pickerFilter" })} />
          <CommandList>
            <CommandEmpty>{intl.formatMessage({ id: "dbboard.knowledge.noMatch" })}</CommandEmpty>
            <CommandGroup>
              {tables.slice(0, 500).map((table) => {
                const card = knowledge?.tables[table.name.toLowerCase()];
                const label = card
                  ? `${card.domain} ${card.purpose}`
                  : table.comment
                    ? table.comment
                    : intl.formatMessage({ id: "dbboard.knowledge.noCard" });
                return (
                  <CommandItem
                    key={`${table.schema}.${table.name}`}
                    value={`${table.name} ${table.comment ?? ""} ${card?.domain ?? ""} ${card?.purpose ?? ""}`}
                    onSelect={() => {
                      onChange(table);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate font-mono text-ui-sm">{table.name}</span>
                        {card ? (
                          <Badge variant="secondary" className="shrink-0">
                            {card.domain}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="shrink-0 text-foreground-subtle">
                            {intl.formatMessage({ id: "dbboard.knowledge.noCard" })}
                          </Badge>
                        )}
                      </span>
                      <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">{label}</span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
