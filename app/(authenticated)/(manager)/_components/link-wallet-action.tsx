"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { CheckCircle2Icon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { ManagerSnapshot } from "@/lib/manager";
import { api } from "@/trpc/client";
import type { AppRouter } from "@/trpc/router";
import { linkWalletActionLabel } from "../_lib/link-wallet-copy";

type LinkWalletConnection =
  inferRouterOutputs<AppRouter>["linkWallet"]["status"];
type PendingLinkAuthorization = Extract<
  LinkWalletConnection,
  { state: "pending" }
>;

export function LinkWalletAction({
  connection,
}: {
  readonly connection: ManagerSnapshot["linkWallet"];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [attemptStartedAt, setAttemptStartedAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();

  const start = api.linkWallet.start.useMutation();
  const disconnect = api.linkWallet.disconnect.useMutation({
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });
  const status = api.linkWallet.status.useQuery(undefined, {
    enabled: open && !disconnect.isSuccess && start.data?.state === "pending",
    refetchInterval: (query) => {
      if (query.state.error) return false;
      return query.state.data?.state === "pending" ? 2000 : false;
    },
    refetchIntervalInBackground: false,
    retry: false,
  });

  const polledConnection =
    status.dataUpdatedAt >= attemptStartedAt ? status.data : undefined;
  const liveConnection = polledConnection ?? start.data;
  const currentState = disconnect.isSuccess
    ? "disconnected"
    : start.isPending
      ? "connecting"
      : managerConnectionState(liveConnection, connection.state);
  const authorization =
    !disconnect.isSuccess && liveConnection?.state === "pending"
      ? liveConnection
      : undefined;
  const accountLabel =
    !disconnect.isSuccess && liveConnection?.state === "connected"
      ? (liveConnection.accountLabel ?? null)
      : connection.accountLabel;

  const liveState = liveConnection?.state;
  useEffect(() => {
    if (liveState && liveState !== "pending") router.refresh();
  }, [liveState, router]);

  const beginConnection = () => {
    setAttemptStartedAt(Date.now());
    setCopied(false);
    setCopyError(undefined);
    setOpen(true);
    disconnect.reset();
    start.reset();
    start.mutate();
  };

  const openDialog = () => {
    if (currentState !== "connected") {
      beginConnection();
      return;
    }
    setCopied(false);
    setCopyError(undefined);
    disconnect.reset();
    start.reset();
    setOpen(true);
  };

  const copyPhrase = async () => {
    if (!authorization) return;
    setCopyError(undefined);
    try {
      await navigator.clipboard.writeText(authorization.phrase);
      setCopied(true);
    } catch {
      setCopyError("Unable to copy the phrase. Select and copy it manually.");
    }
  };

  const visibleError =
    copyError ??
    (start.error
      ? "Unable to start Link verification. Try again."
      : undefined) ??
    (status.error && status.errorUpdatedAt >= attemptStartedAt
      ? "Unable to check Link verification. Close this window and try again."
      : undefined) ??
    (disconnect.error
      ? "Unable to disconnect Link Wallet. Try again."
      : undefined) ??
    connectionError(liveConnection, attemptStartedAt > 0);
  const isConnected = currentState === "connected";
  const actionLabel = linkWalletActionLabel(currentState);

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setCopied(false);
      }}
      open={open}
    >
      <Button
        disabled={
          currentState === "unavailable" ||
          start.isPending ||
          disconnect.isPending
        }
        onClick={openDialog}
        size="sm"
        type="button"
        variant="outline"
      >
        {start.isPending ? <Spinner /> : null}
        {start.isPending ? "Starting…" : actionLabel}
      </Button>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isConnected ? "Link Wallet connection" : "Connect Link Wallet"}
          </DialogTitle>
          <DialogDescription>
            {isConnected
              ? "This workspace can request one-time payment details from Link for approved browser checkouts."
              : "Approve this workspace in Link. Your real payment details stay in Link and are not stored here."}
          </DialogDescription>
        </DialogHeader>

        {isConnected ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              <p className="type-label">Connected</p>
            </div>
            <p className="mt-1 type-caption text-muted-foreground">
              {accountLabel ?? "Link account"}
            </p>
          </div>
        ) : authorization ? (
          <VerificationDetails
            authorization={authorization}
            copied={copied}
            onCopy={() => void copyPhrase()}
          />
        ) : start.isPending ? (
          <output
            aria-live="polite"
            className="flex items-center gap-2 type-caption text-muted-foreground"
          >
            <Spinner />
            Starting secure verification…
          </output>
        ) : null}

        {visibleError ? (
          <p className="type-caption text-destructive" role="alert">
            {visibleError}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          {isConnected ? (
            <Button
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              type="button"
              variant="destructive"
            >
              {disconnect.isPending ? <Spinner /> : null}
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          ) : authorization ? (
            <Button
              nativeButton={false}
              render={
                <a
                  href={authorization.verificationUrl}
                  rel="noreferrer"
                  target="_blank"
                />
              }
            >
              Open Link
              <ExternalLinkIcon />
            </Button>
          ) : currentState === "unavailable" ? null : (
            <Button
              disabled={start.isPending}
              onClick={beginConnection}
              type="button"
            >
              {start.isPending ? <Spinner /> : null}
              {start.isPending ? "Starting…" : "Try again"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VerificationDetails({
  authorization,
  copied,
  onCopy,
}: {
  readonly authorization: PendingLinkAuthorization;
  readonly copied: boolean;
  readonly onCopy: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <p className="type-caption text-muted-foreground">
          Verification phrase
        </p>
        <div className="mt-1 flex items-center gap-2">
          <code
            aria-label={`Verification phrase: ${authorization.phrase}`}
            className="min-w-0 flex-1 type-card-title select-all"
          >
            {authorization.phrase}
          </code>
          <Button
            aria-label={
              copied ? "Verification phrase copied" : "Copy verification phrase"
            }
            onClick={onCopy}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {copied ? (
              <CheckCircle2Icon className="text-success" />
            ) : (
              <CopyIcon />
            )}
          </Button>
        </div>
        <output aria-live="polite" className="sr-only">
          {copied ? "Verification phrase copied." : ""}
        </output>
      </div>
      <p className="type-caption text-muted-foreground">
        Open{" "}
        <a
          className="break-all underline underline-offset-3 hover:text-foreground"
          href={authorization.verificationUrl}
          rel="noreferrer"
          target="_blank"
        >
          {authorization.verificationUrl}
        </a>{" "}
        and enter the phrase above.
      </p>
      <output
        aria-live="polite"
        className="flex items-center gap-2 type-caption text-muted-foreground"
      >
        <Spinner />
        Waiting for approval in Link…
      </output>
    </div>
  );
}

function managerConnectionState(
  liveConnection: LinkWalletConnection | undefined,
  fallback: ManagerSnapshot["linkWallet"]["state"]
): ManagerSnapshot["linkWallet"]["state"] {
  if (!liveConnection) return fallback;
  return liveConnection.state === "pending"
    ? "connecting"
    : liveConnection.state;
}

function connectionError(
  liveConnection: LinkWalletConnection | undefined,
  attempted: boolean
) {
  switch (liveConnection?.state) {
    case "reauthentication-required":
      return "Link needs to verify this connection again.";
    case "unavailable":
      return (
        liveConnection.reason ??
        "Link Wallet is unavailable in this deployment."
      );
    case "disconnected":
      return attempted
        ? "Link verification ended. Start again to connect."
        : undefined;
    default:
      return undefined;
  }
}
