import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  REMOTE_DESKTOP_SOCKET_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Socket from "effect/unstable/socket/Socket";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const remoteDesktopHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "remoteDesktop",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* ServerSettingsService;
    return handlers.handle(
      "connection",
      Effect.fn("remoteDesktop.connection")(function* () {
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        const { remoteDesktop } = yield* settings.getSettings.pipe(
          Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
        );
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
        );
        return {
          enabled: remoteDesktop.enabled,
          password: remoteDesktop.enabled ? remoteDesktop.password : "",
          username: remoteDesktop.enabled ? remoteDesktop.username : "",
        };
      }),
    );
  }),
);

/** Opaque RFB bytes use a separate socket and never enter thread history. */
export const proxyRemoteDesktop = Effect.fn("remoteDesktop.proxy")(function* (
  client: Socket.Socket,
  port: number,
) {
  const upstream = yield* NodeSocket.makeNet({
    host: "127.0.0.1",
    port,
    openTimeout: "10 seconds",
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const clientWriter = yield* client.writer;
      const upstreamWriter = yield* upstream.writer;
      return yield* Effect.raceFirst(pump(upstream, clientWriter), pump(client, upstreamWriter));
    }),
  );
});

const pump = Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
  const reader = yield* source.reader;
  while (true) yield* sink.writeAll(yield* reader.pull);
});

export const remoteDesktopSocketRouteLayer = HttpRouter.add(
  "GET",
  REMOTE_DESKTOP_SOCKET_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
    }
    const settings = yield* ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    const { remoteDesktop } = yield* settings.getSettings.pipe(
      Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
    );
    if (!remoteDesktop.enabled) {
      return HttpServerResponse.text("Remote desktop is disabled", { status: 503 });
    }
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("WebSocket upgrade required", { status: 426 });
    }
    const client = yield* request.upgrade;
    yield* Effect.raceFirst(
      proxyRemoteDesktop(client, remoteDesktop.port),
      changes.pipe(
        Stream.filter(
          (next) =>
            !next.remoteDesktop.enabled ||
            next.remoteDesktop.port !== remoteDesktop.port ||
            next.remoteDesktop.password !== remoteDesktop.password ||
            next.remoteDesktop.username !== remoteDesktop.username,
        ),
        Stream.runHead,
      ),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }),
);
