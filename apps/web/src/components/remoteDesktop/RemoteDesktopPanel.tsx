import { useAtomValue } from "@effect/atom-react";
import RFB from "@novnc/novnc";
import { resolveRemoteDesktopAccess } from "@t3tools/client-runtime/state/remoteDesktop";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "~/connection/runtime";
import { formatEnvironmentQueryError } from "~/state/query";
import { useEnvironment } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { RemoteDesktopSetup } from "./RemoteDesktopSetup";

function RemoteDesktopViewer({ environmentId }: { environmentId: EnvironmentId }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <RemoteDesktopConnection
      key={attempt}
      environmentId={environmentId}
      onReconnect={() => setAttempt((value) => value + 1)}
    />
  );
}

function RemoteDesktopConnection({
  environmentId,
  onReconnect,
}: {
  environmentId: EnvironmentId;
  onReconnect: () => void;
}) {
  const runtime = useAtomValue(connectionAtomRuntime);
  const services = AsyncResult.isSuccess(runtime) ? runtime.value : null;
  const prepared = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const screen = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  const [connected, setConnected] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!services || !prepared || !screen.current) return;
    const target = screen.current;
    let disposed = false;
    let rfb: RFB | undefined;
    setConnected(false);
    setFailure(null);
    setStatus("Connecting…");
    // Every effect setup mints its own ticket, including React Strict Mode remounts.
    const cancel = Effect.runCallbackWith(services)(resolveRemoteDesktopAccess(prepared), {
      onExit: (exit) => {
        if (disposed) return;
        if (Exit.isFailure(exit)) {
          setFailure(formatEnvironmentQueryError(exit.cause));
          return;
        }
        if (!exit.value.enabled) {
          setFailure("Remote desktop is disabled on this environment.");
          return;
        }
        try {
          rfb = new RFB(target, exit.value.socketUrl, {
            shared: true,
            credentials: {
              password: exit.value.password,
              username: exit.value.username,
              target: "",
            },
          });
        } catch {
          setFailure("Could not open the desktop connection. Reconnect to try again.");
          return;
        }
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.addEventListener("connect", () => {
          if (!disposed) {
            setConnected(true);
            setStatus("Connected");
          }
        });
        rfb.addEventListener("disconnect", () => {
          if (disposed) return;
          setConnected(false);
          setFailure(
            (current) =>
              current ??
              "Desktop disconnected. Check that the Mac is awake and Screen Sharing is enabled.",
          );
        });
        rfb.addEventListener("securityfailure", () => {
          if (!disposed)
            setFailure(
              "VNC authentication failed. Check the saved password and, for account authentication, the Mac username.",
            );
        });
        rfb.addEventListener("credentialsrequired", () => {
          if (!disposed)
            setFailure(
              "Configure VNC password access on the remote Mac, or save its account username and password here.",
            );
          rfb?.disconnect();
        });
      },
    });
    return () => {
      disposed = true;
      cancel();
      rfb?.disconnect();
    };
  }, [services, prepared]);

  const error = AsyncResult.isFailure(runtime)
    ? formatEnvironmentQueryError(runtime.cause)
    : failure;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span role="status" className="min-w-0 flex-1">
          {error ? "Disconnected" : status}
        </span>
        <Button size="xs" variant="ghost" onClick={onReconnect}>
          Reconnect
        </Button>
      </div>
      {error ? (
        <div role="alert" className="border-b px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <div
        ref={screen}
        data-remote-desktop-screen
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
      />
      {!connected && !error ? (
        <div className="flex shrink-0 items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
          <Spinner /> Connecting to the remote desktop…
        </div>
      ) : null}
    </>
  );
}

export function RemoteDesktopPanel({
  environmentId,
  visible,
}: {
  environmentId: EnvironmentId;
  visible: boolean;
}) {
  const environment = useEnvironment(environmentId);
  const [configuring, setConfiguring] = useState(false);
  const settings = environment?.serverConfig?.settings.remoteDesktop;
  const supported = environment?.serverConfig?.environment.capabilities.remoteDesktop === true;
  const connected = environment?.connection.phase === "connected";
  return (
    <PreviewPanelShell mode="embedded">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm">{environment?.label ?? "Remote desktop"}</p>
        {supported && settings?.enabled ? (
          <Button size="xs" variant="ghost" onClick={() => setConfiguring((value) => !value)}>
            {configuring ? "Back to desktop" : "Configure"}
          </Button>
        ) : null}
      </div>
      {!connected ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Connect this environment to view its desktop.
        </p>
      ) : !supported || !settings ? (
        <p className="p-4 text-sm text-muted-foreground">
          Update T3 Code on this environment to use remote desktop.
        </p>
      ) : configuring || !settings.enabled ? (
        <div className="overflow-auto p-4">
          <RemoteDesktopSetup
            key={environmentId}
            environmentId={environmentId}
            settings={settings}
            onSaved={() => setConfiguring(false)}
          />
        </div>
      ) : visible ? (
        <RemoteDesktopViewer key={environmentId} environmentId={environmentId} />
      ) : null}
    </PreviewPanelShell>
  );
}
