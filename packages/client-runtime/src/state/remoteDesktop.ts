import { REMOTE_DESKTOP_SOCKET_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

/** Resolve fresh credentials whenever a viewer connects, including after relay renewal. */
export const resolveRemoteDesktopAccess = Effect.fn("clientRuntime.resolveRemoteDesktopAccess")(
  function* (prepared: PreparedConnection) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const connection = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "remoteDesktop",
      method: "GET",
      url: (base) => environmentEndpointUrl(base, "/api/remote-desktop/connection"),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.connection({ headers }),
    });
    if (!connection.enabled) return { enabled: false as const };
    let httpBaseUrl = prepared.httpBaseUrl;
    let wsTicket: string | undefined;
    if (prepared.httpAuthorization !== null) {
      const ticket = yield* executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer,
        remoteAuthorization,
        group: "auth",
        method: "POST",
        url: (base) => environmentEndpointUrl(base, "/api/auth/websocket-ticket"),
        timeoutMs: 8_000,
        request: ({ client, headers, httpBaseUrl }) =>
          client
            .webSocketTicket({ headers })
            .pipe(Effect.map((ticket) => ({ ...ticket, httpBaseUrl }))),
      });
      httpBaseUrl = ticket.httpBaseUrl;
      wsTicket = ticket.ticket;
    }
    const socketUrl = new URL(environmentEndpointUrl(httpBaseUrl, REMOTE_DESKTOP_SOCKET_PATH));
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    if (wsTicket !== undefined) socketUrl.searchParams.set("wsTicket", wsTicket);
    return {
      enabled: true as const,
      socketUrl: socketUrl.toString(),
      password: connection.password,
      username: connection.username,
    };
  },
);
