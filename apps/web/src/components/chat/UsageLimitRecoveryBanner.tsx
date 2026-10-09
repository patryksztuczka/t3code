import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackContent } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackContent {
  const { runId, resetAt } = props;
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    content: <UsageLimitRecoveryBanner key={`${runId}:${resetAt}`} {...props} />,
  };
}

function UsageLimitRecoveryBanner({
  runId,
  resetAt,
  stoppedAt,
  recovery,
  snoozedUntil,
  onChange,
}: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resetDate = resetAt === null ? null : new Date(resetAt);
  const today = new Date(nowMs);
  const resetLabel = resetDate?.toLocaleString(undefined, {
    ...(resetDate.toDateString() === today.toDateString()
      ? {}
      : {
          month: "short",
          day: "numeric",
          ...(resetDate.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
        }),
    hour: "numeric",
    minute: "2-digit",
  });
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
    setPending(false);
  }
  return (
    <>
      <ComposerBanner.Row role="status">
        <ComposerBanner.Icon>
          <GaugeIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="flex-wrap gap-x-1.5">
          <span className="shrink-0 font-medium leading-7 sm:leading-6">Usage limit reached</span>
          {resetAt ? (
            <time
              dateTime={resetAt}
              className={scheduled ? "text-success" : "text-muted-foreground"}
            >
              {scheduled ? "Resumes at" : snoozed ? "Snoozed until" : "Resets"} {resetLabel}
            </time>
          ) : (
            <span className="text-muted-foreground">Reset time unavailable; retry manually</span>
          )}
        </ComposerBanner.Content>
        {canSchedule ? (
          <ComposerBanner.Actions className="@max-[480px]:col-[2/4] @max-[480px]:row-start-2 @max-[480px]:-ms-2 @max-[480px]:justify-start">
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => void toggle("resume")}
            >
              {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending || (!snoozed && Date.parse(resetAt!) <= nowMs)}
              onClick={() => void toggle("snooze")}
            >
              {pending ? "Saving..." : snoozed ? "Unsnooze" : "Snooze until reset"}
            </Button>
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {error ? (
        <ComposerBanner.Body className="flex items-start gap-2 pb-1">
          <p
            role="alert"
            className="min-w-0 flex-1 text-xs leading-4 wrap-anywhere text-destructive"
          >
            {error}
          </p>
          <ComposerBanner.Dismiss
            size="icon-tiny"
            aria-label="Dismiss recovery error"
            onClick={() => setError(null)}
          />
        </ComposerBanner.Body>
      ) : null}
    </>
  );
}
