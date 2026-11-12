import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Icon button with a bb-styled tooltip; `label` is also its accessible name, `hint` the tooltip's second line. */
export function IconAction({
  icon,
  label,
  hint,
  className,
  iconClassName,
  tooltipClassName,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  hint?: string;
  className?: string;
  iconClassName?: string;
  tooltipClassName?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          className={className}
          aria-label={label}
          onClick={onClick}
        >
          <Icon name={icon} className={iconClassName} />
        </Button>
      </TooltipTrigger>
      <TooltipContent className={tooltipClassName}>
        <div>{label}</div>
        {hint === undefined ? null : <div className="text-xs opacity-70">{hint}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
