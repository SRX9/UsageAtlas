import { Switch } from "@heroui/react";

export function ComparisonToggle({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return (
    <Switch aria-label="Compare with the previous period" className="atlas-compare-toggle" isSelected={checked} onChange={onChange}>
      <Switch.Content>
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <span className="text-sm font-medium">Compare</span>
      </Switch.Content>
    </Switch>
  );
}

export function AnalyzerControlsSpacer(): React.JSX.Element {
  return <span className="atlas-delta">Period total</span>;
}
