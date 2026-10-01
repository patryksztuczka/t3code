import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const REMOTE_DESKTOP_SOCKET_PATH = "/api/remote-desktop/socket";

export const RemoteDesktopPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const RemoteDesktopSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  port: RemoteDesktopPort.pipe(Schema.withDecodingDefault(Effect.succeed(5900))),
  username: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Passwords are opaque, including leading and trailing spaces.
  password: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type RemoteDesktopSettings = typeof RemoteDesktopSettings.Type;

/** Credentials are returned only to clients authorized to control the environment. */
export const RemoteDesktopConnection = Schema.Struct({
  enabled: Schema.Boolean,
  password: Schema.String,
  username: Schema.String,
});
export type RemoteDesktopConnection = typeof RemoteDesktopConnection.Type;
