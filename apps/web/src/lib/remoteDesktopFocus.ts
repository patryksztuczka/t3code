/** The VNC canvas owns keyboard input while focused, including Escape and T3 shortcuts. */
export function isRemoteDesktopFocused(): boolean {
  return (
    typeof document !== "undefined" &&
    Boolean(document.activeElement?.closest("[data-remote-desktop-screen]"))
  );
}
