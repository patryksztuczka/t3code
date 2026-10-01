import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type RemoteDesktopSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Socket from "effect/unstable/socket/Socket";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../auth/EnvironmentAuth.ts";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { remoteDesktopHttpApiLayer, remoteDesktopSocketRouteLayer } from "./http.ts";

class DesktopTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.remoteDesktop,
) {}

const authLayer = (scopes: ReadonlyArray<AuthEnvironmentScope> | null) => {
  const authenticate = () =>
    scopes === null
      ? Effect.fail(new ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("desktop-test"),
          subject: "test",
          method: "bearer-access-token" as const,
          scopes,
        });
  return Layer.succeed(EnvironmentAuth, {
    authenticateHttpRequest: authenticate,
    authenticateWebSocketUpgrade: authenticate,
  } as unknown as EnvironmentAuth["Service"]);
};

const settingsLayer = (remoteDesktop: Partial<RemoteDesktopSettings> = {}) =>
  Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const current = yield* Ref.make({
        ...DEFAULT_SERVER_SETTINGS,
        remoteDesktop: { ...DEFAULT_SERVER_SETTINGS.remoteDesktop, ...remoteDesktop },
      });
      const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
      return ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(current),
        updateSettings: (patch) =>
          Effect.gen(function* () {
            const next = yield* Ref.updateAndGet(current, (settings) => ({
              ...settings,
              remoteDesktop: { ...settings.remoteDesktop, ...patch.remoteDesktop },
            }));
            yield* PubSub.publish(changes, next);
            return next;
          }),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  );

const httpFixture = (scopes: ReadonlyArray<AuthEnvironmentScope> | null, enabled = true) =>
  HttpRouter.toWebHandler(
    Layer.merge(
      remoteDesktopSocketRouteLayer,
      HttpApiBuilder.layer(DesktopTestApi).pipe(
        Layer.provide(remoteDesktopHttpApiLayer),
        Layer.provide(environmentAuthenticatedAuthLayer),
      ),
    ).pipe(
      Layer.provideMerge(settingsLayer({ enabled, password: "vnc-secret", username: "mac-user" })),
      Layer.provideMerge(authLayer(scopes)),
      Layer.provideMerge(NodeHttpPlatform.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
    { disableLogger: true },
  );

describe("remote desktop access", () => {
  for (const scopes of [null, [AuthOrchestrationReadScope]]) {
    it(`rejects ${scopes === null ? "unauthenticated" : "read-only"} credentials and sockets`, async () => {
      const { handler, dispose } = httpFixture(scopes);
      try {
        for (const path of ["connection", "socket"]) {
          const response = await handler(new Request(`http://t3.test/api/remote-desktop/${path}`));
          expect(response.status).toBe(scopes === null ? 401 : 403);
          expect(await response.text()).not.toContain("vnc-secret");
        }
      } finally {
        await dispose();
      }
    });
  }

  it("returns credentials only when enabled and prevents browser caching", async () => {
    for (const enabled of [false, true]) {
      const { handler, dispose } = httpFixture([AuthOrchestrationOperateScope], enabled);
      try {
        const response = await handler(new Request("http://t3.test/api/remote-desktop/connection"));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
          enabled,
          password: enabled ? "vnc-secret" : "",
          username: enabled ? "mac-user" : "",
        });
        const socket = await handler(new Request("http://t3.test/api/remote-desktop/socket"));
        expect(socket.status).toBe(enabled ? 426 : 503);
      } finally {
        await dispose();
      }
    }
  });
});

const readBytes = Effect.fnUntraced(function* (reader: Socket.Reader, length: number) {
  const bytes: number[] = [];
  while (bytes.length < length) {
    for (const chunk of yield* reader.pull)
      bytes.push(...(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk));
  }
  return bytes;
});

describe("remote desktop transport", () => {
  for (const change of [
    { enabled: false },
    { port: 1 },
    { password: "changed" },
    { username: "other-user" },
  ]) {
    it.live(
      `forwards binary desktop and input data and closes on ${Object.keys(change)[0]} change`,
      () =>
        Effect.gen(function* () {
          const closed = yield* Deferred.make<void>();
          const upstream = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 });
          if (upstream.address._tag !== "InetAddressV4")
            return yield* Effect.die("Expected an IPv4 address");
          const port = upstream.address.port;
          const banner = new TextEncoder().encode("RFB 003.008\n");
          yield* upstream
            .run((socket) =>
              Effect.gen(function* () {
                const writer = yield* socket.writer;
                const reader = yield* socket.reader;
                yield* writer.writeAll([banner]);
                while (true) yield* writer.writeAll(yield* reader.pull);
              }).pipe(
                Effect.scoped,
                Effect.ignoreCause,
                Effect.ensuring(Deferred.succeed(closed, undefined)),
              ),
            )
            .pipe(Effect.forkScoped);

          const serverLayer = HttpRouter.serve(remoteDesktopSocketRouteLayer, {
            disableLogger: true,
            disableListenLog: true,
          }).pipe(
            Layer.provideMerge(authLayer([AuthOrchestrationOperateScope])),
            Layer.provideMerge(settingsLayer({ enabled: true, port })),
            Layer.provideMerge(NodeHttpServer.layerTest),
          );
          yield* Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer;
            if (typeof server.address === "string" || !("port" in server.address))
              return yield* Effect.die("Expected a TCP HTTP server");
            const client = yield* Socket.makeWebSocket(
              `ws://127.0.0.1:${server.address.port}/api/remote-desktop/socket`,
            );
            const writer = yield* client.writer;
            const reader = yield* client.reader;
            expect(yield* readBytes(reader, banner.length)).toEqual([...banner]);
            // Includes bytes that are not valid UTF-8 and a VNC pointer event.
            const input = new Uint8Array([5, 1, 0, 255, 0, 128, 0, 254]);
            yield* writer.writeAll([input]);
            expect(yield* readBytes(reader, input.length)).toEqual([...input]);
            // Saving an unchanged configuration must leave the existing connection usable.
            yield* (yield* ServerSettingsService).updateSettings({ remoteDesktop: { port } });
            yield* writer.writeAll([input]);
            expect(yield* readBytes(reader, input.length)).toEqual([...input]);
            yield* (yield* ServerSettingsService).updateSettings({ remoteDesktop: change });
            expect(Exit.isFailure(yield* Effect.exit(reader.pull))).toBe(true);
            yield* Deferred.await(closed);
          }).pipe(Effect.provide(Layer.merge(serverLayer, NodeSocket.layerWebSocketConstructorWS)));
        }),
    );
  }
});
