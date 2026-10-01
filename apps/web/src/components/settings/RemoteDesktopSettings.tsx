import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { RemoteDesktopSetup } from "../remoteDesktop/RemoteDesktopSetup";

export function RemoteDesktopSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.remoteDesktop === true,
  );
  return (
    <SettingsSection id="remote-desktop" title="Remote desktop">
      {projectScope ? (
        <p className="text-sm text-muted-foreground">
          Choose an environment to configure its desktop.
        </p>
      ) : supported.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect or update an environment to configure remote desktop.
        </p>
      ) : (
        supported.map((environment) =>
          environment.serverConfig ? (
            <div key={environment.environmentId} className="space-y-3 py-3">
              <p className="text-sm font-medium">{environment.label}</p>
              <RemoteDesktopSetup
                environmentId={environment.environmentId}
                settings={environment.serverConfig.settings.remoteDesktop}
              />
            </div>
          ) : null,
        )
      )}
    </SettingsSection>
  );
}
