import {
  BotIcon,
  CloudIcon,
  ImageIcon,
  MailIcon,
  WalletCardsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { env } from "@/lib/env";
import { requireRequestScope } from "@/lib/request-scope";
import { managerSnapshotSchema, type ManagerSnapshot } from "@/lib/manager";
import { readManagerSnapshot } from "@/lib/manager/server/store";
import { GoogleWorkspaceAction } from "./_components/google-workspace-action";
import { ChannelsSection } from "./_components/channels-section";
import { LinkWalletAction } from "./_components/link-wallet-action";
import { ModelSelector } from "./_components/model-selector";
import { linkWalletDescription } from "./_lib/link-wallet-copy";

export default async function Page({ searchParams }: PageProps<"/">) {
  const google = (await searchParams).google;
  const scope = await requireRequestScope();
  const snapshot = managerSnapshotSchema.parse(
    await readManagerSnapshot(scope)
  );
  const browserReady = snapshot.browser.available;
  const imageStorageReady = Boolean(
    env.BLOB_STORE_ID ?? env.BLOB_READ_WRITE_TOKEN
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="sr-only">Workspace</h1>

      {google === "unavailable" ? (
        <Alert>
          <MailIcon />
          <AlertTitle>Google Workspace unavailable</AlertTitle>
          <AlertDescription>
            This deployment does not have a working Google OAuth connector yet.
          </AlertDescription>
        </Alert>
      ) : null}

      <ChannelsSection
        browserReady={browserReady}
        linqPhoneNumber={env.LINQ_PHONE_NUMBER}
      />
      <ConnectionsSection
        googleWorkspace={snapshot.googleWorkspace}
        linkWallet={snapshot.linkWallet}
      />

      <WorkspaceSection headingId="connectors-heading" title="Infrastructure">
        <div className="divide-y divide-border/50 border-y border-border/50">
          <ConnectorRow
            action={
              <span className="type-caption text-muted-foreground">
                {browserReady ? "Connected" : "Unavailable"}
              </span>
            }
            description="Run isolated browsers in your Kernel account."
            icon={<CloudIcon />}
            label="Kernel browser"
          />
          <ConnectorRow
            action={
              <span className="type-caption text-muted-foreground">
                {imageStorageReady ? "Connected" : "Unavailable"}
              </span>
            }
            description={
              imageStorageReady
                ? "Store browser images in a private Vercel Blob store."
                : "Connect a private Vercel Blob store to share browser images."
            }
            icon={<ImageIcon />}
            label="Vercel Blob"
          />
          <ConnectorRow
            action={<ModelSelector modelId={snapshot.runtime.inference} />}
            description={snapshot.runtime.inference}
            icon={<BotIcon />}
            label="AI Gateway model"
          />
        </div>
      </WorkspaceSection>
    </div>
  );
}

function ConnectionsSection({
  googleWorkspace,
  linkWallet,
}: {
  readonly googleWorkspace: ManagerSnapshot["googleWorkspace"];
  readonly linkWallet: ManagerSnapshot["linkWallet"];
}) {
  const state = googleWorkspace.state;
  const description =
    state === "connected"
      ? (googleWorkspace.accountLabel ??
        "Gmail, Calendar, and Contacts connected.")
      : state === "unavailable"
        ? "Attach a Vercel Connect Google OAuth connector to enable this."
        : "Gmail, Calendar, and Contacts through your Google account.";

  return (
    <WorkspaceSection headingId="connections-heading" title="Connections">
      <div className="divide-y divide-border/50 border-y border-border/50">
        <ConnectorRow
          action={<GoogleWorkspaceAction state={state} />}
          description={description}
          icon={<MailIcon />}
          label="Google Workspace"
        />
        <ConnectorRow
          action={<LinkWalletAction connection={linkWallet} />}
          description={linkWalletDescription(linkWallet)}
          icon={<WalletCardsIcon />}
          label="Link Wallet"
        />
      </div>
    </WorkspaceSection>
  );
}

function WorkspaceSection({
  children,
  headingId,
  title,
}: {
  readonly children: ReactNode;
  readonly headingId: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 className="type-section-title" id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ConnectorRow({
  action,
  description,
  icon,
  label,
}: {
  readonly action: ReactNode;
  readonly description: string;
  readonly icon: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="type-label">{label}</p>
        <p className="truncate type-caption text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
