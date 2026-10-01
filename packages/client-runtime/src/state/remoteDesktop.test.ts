import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { resolveRemoteDesktopAccess } from "./remoteDesktop.ts";

const environmentId = EnvironmentId.make("mac-2");
const base = {
  environmentId,
  label: "Remote Mac",
  httpBaseUrl: "https://mac-2.test",
  socketUrl: "wss://mac-2.test/ws",
};
const credentials = { enabled: true, password: "saved-vnc-password", username: "mac-user" };
const ticket = (value: string) =>
  Response.json({ ticket: value, expiresAt: "2026-10-01T12:00:00.000Z" });

describe("remote desktop connection", () => {
  it.effect("uses the environment cookie without another login or ticket", () =>
    Effect.gen(function* () {
      const calls: RequestInit[] = [];
      const prepared: PreparedConnection = {
        ...base,
        httpAuthorization: null,
        target: new PrimaryConnectionTarget({ ...base, wsBaseUrl: base.socketUrl }),
      };
      const access = yield* resolveRemoteDesktopAccess(prepared).pipe(
        Effect.provide(
          remoteHttpClientLayer(async (_url, init) => {
            calls.push(init ?? {});
            return Response.json(credentials);
          }),
        ),
      );
      expect(access).toEqual({
        ...credentials,
        socketUrl: "wss://mac-2.test/api/remote-desktop/socket",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.credentials).toBe("include");
    }),
  );

  it.effect(
    "mints a fresh single-use ticket for each bearer reconnect without putting its token in the URL",
    () =>
      Effect.gen(function* () {
        const calls: { url: string; authorization: string | null }[] = [];
        const prepared: PreparedConnection = {
          ...base,
          httpAuthorization: { _tag: "Bearer", token: "private-bearer-token" },
          target: new BearerConnectionTarget({ ...base, connectionId: "paired-mac" }),
        };
        const httpLayer = remoteHttpClientLayer(async (url, init) => {
          calls.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return String(url).endsWith("/connection")
            ? Response.json(credentials)
            : ticket(`ticket-${calls.length}`);
        });
        const first = yield* resolveRemoteDesktopAccess(prepared).pipe(Effect.provide(httpLayer));
        const second = yield* resolveRemoteDesktopAccess(prepared).pipe(Effect.provide(httpLayer));
        expect(first).toEqual({
          ...credentials,
          socketUrl: "wss://mac-2.test/api/remote-desktop/socket?wsTicket=ticket-2",
        });
        expect(second).toEqual({
          ...credentials,
          socketUrl: "wss://mac-2.test/api/remote-desktop/socket?wsTicket=ticket-4",
        });
        expect(calls.every((call) => call.authorization === "Bearer private-bearer-token")).toBe(
          true,
        );
      }),
  );

  it.effect("does not mint a socket ticket while desktop sharing is disabled", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const prepared: PreparedConnection = {
        ...base,
        httpAuthorization: { _tag: "Bearer", token: "token" },
        target: new BearerConnectionTarget({ ...base, connectionId: "paired-mac" }),
      };
      const access = yield* resolveRemoteDesktopAccess(prepared).pipe(
        Effect.provide(
          remoteHttpClientLayer(async (url) => {
            urls.push(String(url));
            return Response.json({ enabled: false, password: "", username: "" });
          }),
        ),
      );
      expect(access).toEqual({ enabled: false });
      expect(urls).toEqual(["https://mac-2.test/api/remote-desktop/connection"]);
    }),
  );

  it.effect(
    "opens the renewed Connect endpoint after a rejected ticket request with fresh request-bound proofs",
    () =>
      Effect.gen(function* () {
        const proofs: ManagedRelayDpopProofInput[] = [];
        const prepared: PreparedConnection = {
          ...base,
          httpAuthorization: { _tag: "Dpop", accessToken: "stale-token", expiresAtEpochMs: 0 },
          target: new RelayConnectionTarget(base),
        };
        const authorization = RemoteEnvironmentAuthorization.of({
          authorizeBearer: () => Effect.die("Unexpected bearer authorization"),
          authorizeDpop: () => Effect.die("Desktop must not replace the conversation socket"),
          authorizeDpopHttp: ({ rejectedAccessToken }) =>
            Effect.succeed({
              environmentId,
              label: base.label,
              httpBaseUrl: rejectedAccessToken ? "https://renewed.test" : "https://current.test",
              httpAuthorization: {
                _tag: "Dpop",
                accessToken: rejectedAccessToken ? "renewed-token" : "current-token",
                expiresAtEpochMs: 9999999999999,
              },
            }),
        });
        const signer = ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: (input) =>
            Effect.sync(() => {
              proofs.push(input);
              return `proof-${proofs.length}`;
            }),
        });
        const urls: string[] = [];
        const access = yield* resolveRemoteDesktopAccess(prepared).pipe(
          Effect.provideService(RemoteEnvironmentAuthorization, authorization),
          Effect.provideService(ManagedRelayDpopSigner, signer),
          Effect.provide(
            remoteHttpClientLayer(async (url) => {
              urls.push(String(url));
              if (urls.length === 1) return Response.json(credentials);
              if (urls.length === 2)
                return Response.json(
                  {
                    _tag: "EnvironmentAuthInvalidError",
                    code: "auth_invalid",
                    reason: "invalid_credential",
                    traceId: "rejected-ticket",
                  },
                  { status: 401 },
                );
              return ticket("renewed-ticket");
            }),
          ),
        );
        expect(access).toEqual({
          ...credentials,
          socketUrl: "wss://renewed.test/api/remote-desktop/socket?wsTicket=renewed-ticket",
        });
        expect(urls).toEqual([
          "https://current.test/api/remote-desktop/connection",
          "https://current.test/api/auth/websocket-ticket",
          "https://renewed.test/api/auth/websocket-ticket",
        ]);
        expect(
          proofs.map(({ method, url, accessToken }) => ({ method, url, accessToken })),
        ).toEqual([
          { method: "GET", url: urls[0], accessToken: "current-token" },
          { method: "POST", url: urls[1], accessToken: "current-token" },
          { method: "POST", url: urls[2], accessToken: "renewed-token" },
        ]);
      }),
  );
});
