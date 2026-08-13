import type { DashboardProvider } from "@usageatlas/contracts";
import { Button, Input, Label, ListBox, Popover, Select, Tooltip } from "@heroui/react";
import { useState } from "react";
import type { AnalyticsRange, ProviderScope } from "../personal-analytics";
import {
  CalendarRangeIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DayIcon,
  HistoryIcon,
  ProvidersIcon,
  TrendsIcon
} from "../icons";
import { ProviderLogo } from "./ProviderLogo";

interface TimeNavigatorProps {
  label: string;
  mode: "day" | "range";
  selectedDay: string;
  selectedRange?: AnalyticsRange;
  canMoveBack?: boolean;
  canMoveForward: boolean;
  onMoveBack(): void;
  onMoveForward(): void;
  onSelectDay(day: string): void;
  onSelectRange(range: AnalyticsRange): void;
}

const ranges: Array<{ value: AnalyticsRange; label: string }> = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: "all", label: "All available" }
];

export function TimeNavigator({
  label,
  mode,
  selectedDay,
  selectedRange,
  canMoveBack = true,
  canMoveForward,
  onMoveBack,
  onMoveForward,
  onSelectDay,
  onSelectRange
}: TimeNavigatorProps): React.JSX.Element {
  const [isOpen, setOpen] = useState(false);
  const closeMenu = (): void => setOpen(false);
  const today = todayValue();
  const yesterday = shiftCalendarDay(today, -1);

  return (
    <div aria-label="Time period" className="atlas-toolbar-cluster" role="group">
      <Tooltip delay={400}>
        <Button className="atlas-toolbar-icon" isIconOnly aria-label={mode === "day" ? "Previous day" : "Previous period"} isDisabled={!canMoveBack} onPress={onMoveBack} variant="tertiary">
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Tooltip.Content>{mode === "day" ? "Previous day" : "Previous period"}</Tooltip.Content>
      </Tooltip>
      <Popover isOpen={isOpen} onOpenChange={setOpen}>
        <Button className="atlas-period-trigger min-w-40 justify-between" variant="secondary">
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-4 text-muted" />
        </Button>
        <Popover.Content className="atlas-time-popover w-[min(28rem,calc(100vw-2rem))]" placement="bottom start">
          <Popover.Dialog className="grid gap-5 p-3 sm:grid-cols-2">
            <div className="atlas-time-menu-section">
              <Popover.Heading className="text-sm font-medium">Choose a day</Popover.Heading>
              <Button
                aria-pressed={mode === "day" && selectedDay === today}
                className="atlas-time-option"
                fullWidth
                onPress={() => { onSelectDay(today); closeMenu(); }}
                variant={mode === "day" && selectedDay === today ? "secondary" : "ghost"}
              >
                <DayIcon className="atlas-time-option__icon" />
                <span className="flex-1 text-start">Today</span>
                {mode === "day" && selectedDay === today ? <CheckIcon className="atlas-time-option__check" /> : null}
              </Button>
              <Button
                aria-pressed={mode === "day" && selectedDay === yesterday}
                className="atlas-time-option"
                fullWidth
                onPress={() => { onSelectDay(yesterday); closeMenu(); }}
                variant={mode === "day" && selectedDay === yesterday ? "secondary" : "ghost"}
              >
                <HistoryIcon className="atlas-time-option__icon" />
                <span className="flex-1 text-start">Yesterday</span>
                {mode === "day" && selectedDay === yesterday ? <CheckIcon className="atlas-time-option__check" /> : null}
              </Button>
              <div className="flex flex-col gap-1 pt-1">
                <Label htmlFor="usage-day">Date</Label>
                <Input
                  id="usage-day"
                  max={todayValue()}
                  onChange={(event) => {
                    if (!event.currentTarget.value) return;
                    onSelectDay(event.currentTarget.value);
                    closeMenu();
                  }}
                  type="date"
                  value={mode === "day" ? selectedDay : ""}
                  variant="secondary"
                />
              </div>
            </div>
            <div className="atlas-time-menu-section">
              <p className="text-sm font-medium">Choose a range</p>
              {ranges.map((range) => (
                <Button
                  aria-pressed={mode === "range" && selectedRange === range.value}
                  className="atlas-time-option atlas-time-option--range"
                  fullWidth
                  key={range.value}
                  onPress={() => { onSelectRange(range.value); closeMenu(); }}
                  variant={mode === "range" && selectedRange === range.value ? "secondary" : "ghost"}
                >
                  {range.value === "all"
                    ? <TrendsIcon className="atlas-time-option__icon" />
                    : <CalendarRangeIcon className="atlas-time-option__icon" />}
                  <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span>{range.label}</span>
                    <span className="text-xs font-normal text-muted">{range.value === "all" ? "Full collected history" : "View trends"}</span>
                  </span>
                  {mode === "range" && selectedRange === range.value ? <CheckIcon className="atlas-time-option__check" /> : null}
                </Button>
              ))}
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Tooltip delay={400}>
        <Button className="atlas-toolbar-icon" isIconOnly aria-label={mode === "day" ? "Next day" : "Next period"} isDisabled={!canMoveForward} onPress={onMoveForward} variant="tertiary">
          <ChevronRightIcon className="size-4" />
        </Button>
        <Tooltip.Content>{mode === "day" ? "Next day" : "Next period"}</Tooltip.Content>
      </Tooltip>
    </div>
  );
}

export function ProviderScopeSelect({
  providers,
  value,
  onChange
}: {
  providers: DashboardProvider[];
  value: ProviderScope;
  onChange(value: ProviderScope): void;
}): React.JSX.Element {
  const selectedProvider = providers.find((provider) => provider.id === value);

  return (
    <Select
      aria-label="Tool"
      className="atlas-provider-select"
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      selectedKey={value}
      variant="secondary"
    >
      <Select.Trigger className="atlas-provider-select__trigger">
        <Select.Value className="atlas-provider-select__value">
          {selectedProvider
            ? <ProviderLogo mini providerID={selectedProvider.id} providerName={selectedProvider.name} />
            : (
              <span aria-hidden="true" className="atlas-provider-option__all-icon">
                <ProvidersIcon />
              </span>
            )}
          <span className="truncate">{selectedProvider?.name ?? "All tools"}</span>
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="atlas-provider-select__popover" placement="bottom end">
        <ListBox aria-label="Tools" className="atlas-provider-options">
          <ListBox.Item className="atlas-provider-option" id="all" textValue="All tools">
            <span aria-hidden="true" className="atlas-provider-option__all-icon">
              <ProvidersIcon />
            </span>
            <span className="atlas-provider-option__label">All tools</span>
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {providers.map((provider) => (
            <ListBox.Item className="atlas-provider-option" id={provider.id} key={provider.id} textValue={provider.name}>
              <ProviderLogo mini providerID={provider.id} providerName={provider.name} />
              <span className="atlas-provider-option__label">{provider.name}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function todayValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftCalendarDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const value = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${value}`;
}
