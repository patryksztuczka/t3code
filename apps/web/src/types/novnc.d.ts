// noVNC 1.7 exports its ESM entry at the package root; DefinitelyTyped still names the old entry.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb";
}
