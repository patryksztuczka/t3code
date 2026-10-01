import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  RemoteDesktopPort,
  type EnvironmentId,
  type RemoteDesktopSettings,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const isValidPort = Schema.is(RemoteDesktopPort);

export function RemoteDesktopSetup({
  environmentId,
  settings,
  onSaved,
}: {
  environmentId: EnvironmentId;
  settings: RemoteDesktopSettings;
  onSaved?: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [port, setPort] = useState(String(settings.port));
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(settings.username);
  const [replacePassword, setReplacePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validPort = isValidPort(Number(port));
  const save = async (enabled: boolean) => {
    if (busy || (enabled && !validPort)) return;
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        patch: {
          remoteDesktop: {
            enabled,
            ...(enabled
              ? { port: Number(port), username, ...(replacePassword ? { password } : {}) }
              : {}),
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Could not save remote desktop settings.",
      );
      return;
    }
    setPassword("");
    setReplacePassword(false);
    onSaved?.();
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save(true);
      }}
    >
      <p className="text-sm text-muted-foreground">
        On the remote Mac, enable Screen Sharing in System Settings → General → Sharing, then enable
        "VNC viewers may control screen with password". Enter that VNC password here once.
      </p>
      <label className="block space-y-1.5 text-sm">
        <span>VNC password</span>
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          placeholder={settings.password ? "Saved password, leave blank to keep" : "VNC password"}
          onChange={(event) => {
            setPassword(event.target.value);
            setReplacePassword(true);
          }}
        />
      </label>
      <label className="block space-y-1.5 text-sm">
        <span>Mac username, if using account authentication</span>
        <Input
          value={username}
          disabled={busy}
          placeholder="Leave blank for VNC password access"
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        If the server requires a Mac account, save its username and account password instead.
      </p>
      <label className="block space-y-1.5 text-sm">
        <span>VNC port on this environment</span>
        <Input
          type="number"
          min={1}
          max={65535}
          required
          value={port}
          disabled={busy}
          onChange={(event) => setPort(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        The desktop shares the Mac's active session. Manual input does not stop the agent.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !validPort}>
          {busy
            ? "Saving…"
            : settings.enabled
              ? onSaved
                ? "Save and reconnect"
                : "Save"
              : "Enable remote desktop"}
        </Button>
        {settings.enabled ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void save(false)}
          >
            Disable remote desktop
          </Button>
        ) : null}
        {settings.password ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPassword("");
              setReplacePassword(true);
            }}
          >
            Clear password on save
          </Button>
        ) : null}
      </div>
      {replacePassword && password === "" ? (
        <p className="text-xs text-muted-foreground">Saving will remove the stored password.</p>
      ) : null}
    </form>
  );
}
